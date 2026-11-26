// T-667: K-05 v1.2's readTurnState with the setup parts' facts (setup/turn-state.ts), against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/setup`). The schema comes from migrating a fresh test schema,
// which test-db.ts drops when the file ends.
//
// Every read runs as K-05 v1.2 states it (README item 26, default 25): through a client whose connections run as
// rosie_job, on the server's primary, under the request's business scope, or on the runtime side when the request names
// no business. The tables' owner (the migrations' role) loads the seeds, so only the reads under test meet row-level
// security. The rows come only from fixture set v1's demo shops (rule 9): each setup part's seeds and the K-04 seeds
// their after chains name (Lee's Barbershop, Lee Home Services, the pet boarding shop, the yoga studio and the master's
// sample cast), K-27's busy block and calendar link seeds, and K-22's code, session and staging tester seeds (another
// person's code, session and account). The rows made here are seed rows under new ids: Lee Home Services' plumbing kind
// as S1-04 writes it before its business; Riley's share with the barbershop as a share with Lee Home Services that has
// ended; and Sam's owner-email code as the barbershop's listing control code, which has no person (S1-75).
//
// Round 2 (DL-925 item 8c): the tables scoped none answer by their rules (fact-homes.ts UNSCOPED_ROWS), each case read
// under one business, another, and none, against handle-sam, whose one person is person-sam.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setBusinessScope, setPersonScope, type Sql, type Tx, withBusiness } from "../scope";
import { createTestDatabase, type TestDatabase } from "../test-db";
import type { FactRef, ReadTurnStateRequest, ReadTurnStateResponse } from "../turn-state";
import {
  NEVER_SETUP_COLUMNS,
  NEVER_SETUP_TABLES,
  type SetupColumnType,
  SETUP_FACT_HOMES,
  type SetupFactHome,
} from "./fact-homes";
import { rowNameSql, TWO_COLUMN_KEYS } from "./row-names";
import { readTurnState, readTurnStateIn, type SetupTurnStateOutcome } from "./turn-state";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

const CONTRACTS = new URL("../../../contracts/", import.meta.url);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 120_000 };

const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const YOGA = "biz-yoga-studio";
/** The movers (K-04's seed-business-head), whose one busy block is Sam's photo block (K-27's seed-busy-block). */
const MOVERS = "biz-movers";
const SAM = "handle-sam";
/** The barbershop's listing control code made here from Sam's owner-email code: a code with no person. */
const CONTROL_CODE = "code-barbershop-listing-control";

interface SeedRow {
  table: string;
  values: Values;
}

interface SeedFile {
  after: string[];
  rows: SeedRow[];
}

interface ListColumn {
  name: string;
  type: string;
  sealedBy?: string;
}

interface ListTable {
  name: string;
  columns: ListColumn[];
  primaryKey: string[];
  rowLevelSecurity: { scope: string; column?: string };
  versioned: boolean;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/**
 * Each setup part's frozen table lists (K-22's four together make the part at v1.3). K-23's is v1.1's alone (T-1561):
 * v1.1 restates all nine of v1's tables with v1's columns unchanged and adds business_setup's two claim columns (K-23
 * v1.1 README default 8; migration 0040), so it is the whole part, as db/repo/business-setup.int.test.ts reads it; read
 * beside v1's, each of its tables would be counted twice.
 */
const PART_LISTS: Readonly<Record<string, readonly string[]>> = {
  "people-access": [
    "people-access.v1.tables.json",
    "people-access.v1.1.tables.json",
    "people-access.v1.2.tables.json",
    "people-access.v1.3.tables.json",
  ],
  "business-setup": ["business-setup.v1.1.tables.json"],
  "kinds-of-work": ["kinds-of-work.v1.tables.json"],
  "services-prices": ["services-prices.v1.tables.json"],
  rules: ["rules.v1.tables.json"],
  availability: ["availability.v1.tables.json"],
  "platform-billing": ["platform-billing.v1.tables.json"],
  "documents-licenses": ["documents-licenses.v1.tables.json"],
};

/** One seed per part, with the row of it the card's proof reads back (each part's own table, the seed's first row). */
const PART_ROWS: readonly { part: string; seed: string; table: string }[] = [
  { part: "people-access", seed: "seed-staff-joined.json", table: "staff" },
  { part: "business-setup", seed: "seed-business-demo-shop.json", table: "business_setup" },
  { part: "business-setup", seed: "seed-business-demo-shop.json", table: "flow_defaults" },
  { part: "business-setup", seed: "seed-company-two-kinds.json", table: "company_kinds" },
  { part: "kinds-of-work", seed: "seed-kinds-sample.json", table: "kinds" },
  { part: "kinds-of-work", seed: "seed-kinds-sample.json", table: "kind_flows" },
  { part: "kinds-of-work", seed: "seed-business-kinds.json", table: "picked_kinds" },
  // Item 77's other two names: a pick's text block (pick id/pf key) and a draft's block (draft id/block, an integer).
  { part: "kinds-of-work", seed: "seed-business-kinds.json", table: "picked_kind_texts" },
  { part: "kinds-of-work", seed: "seed-new-work-draft.json", table: "new_work_draft_blocks" },
  { part: "services-prices", seed: "seed-services-price-list.json", table: "services" },
  { part: "rules", seed: "seed-rules-tap-list.json", table: "rules" },
  { part: "availability", seed: "seed-hours.json", table: "weekly_hours" },
  { part: "platform-billing", seed: "seed-bill-card.json", table: "bill_cards" },
  { part: "documents-licenses", seed: "seed-license-as-given.json", table: "documents" },
];

/**
 * The seeds of the tables scoped none that round 2's proof reads (DL-925 item 8c), with their chains: K-27's links, their
 * shares and busy blocks; K-22's codes and sessions (Sam's, and Jordan's paused code); the staging testers' account, code
 * and session (another person's).
 */
const UNSCOPED_SEEDS: readonly { part: string; seed: string }[] = [
  { part: "availability", seed: "seed-busy-block.json" },
  { part: "people-access", seed: "seed-session.json" },
  { part: "people-access", seed: "seed-staging-tester.json" },
];

/** The registries a migration seeds (K-26 rule 5): a seed chain names their rows, which are already there. */
const MIGRATION_SEEDED = new Set(["trade_facts", "plugin_switches", "rule_kinds"]);

const seedUrl = (part: string, file: string): URL => new URL(`${part}/fixtures/${file}`, DB_SCHEMA_DIR);

/** A seed's `index`th own row of `table`. */
function seedRow(part: string, file: string, table: string, index = 0): Values {
  const row = (readJson(seedUrl(part, file)) as SeedFile).rows.filter((each) => each.table === table)[index];
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row number ${String(index)}`);
  }
  return row.values;
}

/** The one own row of `table` in a seed whose values hold each of `match`'s. */
function seedRowWhere(part: string, file: string, table: string, match: Values): Values {
  const rows = (readJson(seedUrl(part, file)) as SeedFile).rows.filter(
    (row) =>
      row.table === table && Object.entries(match).every(([column, value]) => row.values[column] === value),
  );
  const [row, ...more] = rows;
  if (row === undefined || more.length > 0) {
    throw new Error(`${file} has no one ${table} row that matches`);
  }
  return row.values;
}

/** A seed's rows after those of every seed its `after` names (each path from the naming file's folder), each once. */
function chainRows(file: URL, seen: Set<string>): SeedRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => chainRows(new URL(before, file), seen)), ...seed.rows];
}

/** The rowId K-05 names a home's row by: its one key's value, or item 77's "/" name, from the seed's values. */
function rowIdOf(home: SetupFactHome, values: Values): string {
  return home.key
    .map((column) => {
      const value = values[column];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`a seed key column ${column} holds no text or number`);
      }
      return String(value);
    })
    .join("/");
}

/** A seed interval's whole minutes ("30 minutes", "24 hours", "2 days"), as the read answers an interval. */
function minutesText(text: string): string {
  const match = /^([0-9]+) (minute|minutes|hour|hours|day|days)$/.exec(text);
  if (match === null) {
    throw new Error("a seed interval this test cannot read");
  }
  const count = Number(match[1]);
  const unit = match[2] ?? "";
  const minutes = unit.startsWith("minute") ? count : unit.startsWith("hour") ? count * 60 : count * 1440;
  return `${String(minutes)} minutes`;
}

/** A seed value as the read answers it (setup/turn-state.ts's header). */
function answered(type: SetupColumnType, value: Json): unknown {
  if (value === null) {
    return null;
  }
  return type === "interval" && typeof value === "string" ? minutesText(value) : value;
}

// ---- the contract's own schema, for every answer (Ajv 2020-12, strict, as contracts:check runs it) -----------------

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
const V12_ID = (readJson(new URL("data-access/data-access.v1.2.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** The outcome checked against data-access v1.2's readTurnState response or errors (none when it passes). */
function outcomeErrors(outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  const validate = ajv.getSchema(
    `${V12_ID}#/$defs/${isError ? "readTurnState.errors" : "readTurnState.response"}`,
  );
  if (validate === undefined) {
    throw new Error("data-access v1.2 has no readTurnState definitions");
  }
  return validate(outcome)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

function asTurnState(outcome: SetupTurnStateOutcome): ReadTurnStateResponse {
  if (!("result" in outcome)) {
    throw new Error(`expected a turn state, got ${outcome.error}`);
  }
  return outcome;
}

// ---- databases, clients and seeds -------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, with this file's schema first. */
let runtime: Sql;
/** jsonb and bytea columns of the schema, keyed table.column, for the seed loader. */
let typedColumns: Map<string, string>;

/** Loads seeds with their after chains, each file once, as the tables' owner (not bound by row-level security). */
async function loadSeeds(files: readonly URL[]): Promise<void> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => chainRows(file, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      const values: Record<string, never> = {};
      for (const [column, value] of Object.entries(row.values)) {
        const type = typedColumns.get(`${row.table}.${column}`);
        const out =
          type === "jsonb" && value !== null
            ? tx.json(value)
            : type === "bytea" && typeof value === "string"
              ? fromHex(value.replace(/^\\x/, ""))
              : value;
        values[column] = out as never;
      }
      if (MIGRATION_SEEDED.has(row.table)) {
        await tx`insert into ${tx(row.table)} ${tx(values)} on conflict do nothing`;
      } else {
        await tx`insert into ${tx(row.table)} ${tx(values)}`;
      }
    }
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "setup_turn_state" });
  runtime = db.connect({
    max: 4,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t667-setup-reads",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  await loadSeeds(
    [...new Set([...PART_ROWS, ...UNSCOPED_SEEDS].map((row) => seedUrl(row.part, row.seed).href))].map(
      (href) => new URL(href),
    ),
  );
  // Lee Home Services' plumbing kind and its company as S1-04 writes them before the business exists (a seed row under
  // a new id): seen by no business scope, read on the runtime side.
  const company: Values = {
    ...seedRow("business-setup", "seed-company-two-kinds.json", "companies", 0),
    id: "company-sam-before-business",
    business_id: null,
    version: 1,
  };
  const kind: Values = {
    ...seedRow("business-setup", "seed-company-two-kinds.json", "company_kinds", 0),
    company_id: "company-sam-before-business",
    business_id: null,
    version: 1,
  };
  // Riley's share with the barbershop under a new id, as a share with Lee Home Services that Riley has since ended: the
  // only share of Riley's link with that business.
  const endedShare: Values = {
    ...seedRowWhere("availability", "seed-calendar-link.json", "calendar_link_shares", {
      id: "share-riley-barbershop",
    }),
    id: "share-riley-home-services-ended",
    business_id: HOME_SERVICES,
    ended_at: "2026-11-05T15:00:00Z",
    version: 2,
  };
  // Sam's owner-email code under a new id, as the barbershop's listing control code, which has no person (S1-75).
  const controlCode: Values = {
    ...seedRowWhere("people-access", "seed-proof-code.json", "proof_codes", { id: "code-sam-owner-email" }),
    id: CONTROL_CODE,
    purpose: "listing_control",
    person_id: null,
  };
  await db.sql.begin(async (tx) => {
    await tx`insert into companies ${tx(company as unknown as Record<string, never>)}`;
    await tx`insert into company_kinds ${tx(kind as unknown as Record<string, never>)}`;
    await tx`insert into calendar_link_shares ${tx(endedShare as unknown as Record<string, never>)}`;
    await tx`insert into proof_codes ${tx(controlCode as unknown as Record<string, never>)}`;
  });
}, 180_000);

afterAll(async () => {
  await runtime.end({ timeout: 5 });
  await db.drop();
});

/** Every fact of one home's row, keyed `<table>.<column>`, in the home's column order. */
function factsOfRow(table: string, rowId: string): FactRef[] {
  const home = SETUP_FACT_HOMES[table];
  if (home === undefined) {
    throw new Error(`no setup home ${table}`);
  }
  return Object.keys(home.columns).map((column) => ({ key: `${table}.${column}`, table, rowId, column }));
}

const requestOf = (
  businessId: string | null,
  facts: FactRef[],
  bookingIds: string[] = [],
): ReadTurnStateRequest => ({
  handleId: SAM,
  businessId,
  bookingIds,
  facts,
});

/** The business a seed row's read runs under: its own, or the barbershop for a table scoped none. */
function businessOfRow(home: SetupFactHome, values: Values): string {
  const own = home.scopedBy === null ? null : values[home.scopedBy];
  return typeof own === "string" ? own : BARBERSHOP;
}

// ---- round 2: a table scoped none, read by its rule (DL-925 item 8) ---------------------------------------------------

/** One row of a table scoped none, read as handle-sam under `businessId`: answered with its seed values, or notFound. */
interface Reach {
  readonly businessId: string | null;
  readonly table: string;
  readonly rowId: string;
  /** The row's seed values when the read answers it; null when it answers notFound. */
  readonly seed: Values | null;
  readonly why: string;
}

const yes = (businessId: string | null, table: string, rowId: string, seed: Values, why: string): Reach => ({
  businessId,
  table,
  rowId,
  seed,
  why,
});

const no = (businessId: string | null, table: string, rowId: string, why: string): Reach => ({
  businessId,
  table,
  rowId,
  seed: null,
  why,
});

/** Reads every fact of the case's row: each answered with the row's id, version and seed value, or notFound. */
async function expectReach({ businessId, table, rowId, seed, why }: Reach): Promise<void> {
  const home = SETUP_FACT_HOMES[table];
  if (home === undefined) {
    throw new Error(`no setup home ${table}`);
  }
  const outcome = await readTurnState(runtime, requestOf(businessId, factsOfRow(table, rowId)));
  expect(outcomeErrors(outcome), why).toEqual([]);
  if (seed === null) {
    expect(outcome, why).toEqual({ error: "notFound", table, rowId });
    return;
  }
  const state = asTurnState(outcome);
  expect(
    state.facts.map((fact) => fact.column),
    why,
  ).toEqual(Object.keys(home.columns));
  for (const fact of state.facts) {
    const what = `${why}: ${fact.column}`;
    expect([fact.table, fact.rowId, fact.key, fact.version], what).toEqual([
      table,
      rowId,
      `${table}.${fact.column}`,
      seed.version,
    ]);
    const type = home.columns[fact.column];
    if (type !== undefined && Object.hasOwn(seed, fact.column)) {
      expect(fact.value, what).toEqual(answered(type, seed[fact.column] ?? null));
    }
  }
}

/**
 * Whether the Tool API sees the row: rosie_app under `businessId`'s scope (or none), acting for person-sam (rosie.person_id,
 * K-22 rule 4), as K-22's and K-27's select policies admit it.
 */
async function toolApiSees(businessId: string | null, table: string, rowId: string): Promise<boolean> {
  return db.sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_app");
    if (businessId !== null) {
      await setBusinessScope(tx, businessId);
    }
    await setPersonScope(tx, "person-sam");
    const rows = await tx<{ id: string }[]>`select id from ${tx(table)} where id = ${rowId}`;
    return rows.length === 1;
  });
}

// ---- the frozen lists ----------------------------------------------------------------------------------------------

describe("the setup fact homes", () => {
  it("are every versioned table of the eight setup parts' frozen lists, every column but those never a fact", () => {
    const expected: Record<string, unknown> = {};
    const sealed: string[] = [];
    const leftOutTables: string[] = [];
    for (const [part, lists] of Object.entries(PART_LISTS)) {
      for (const list of lists) {
        const { tables } = readJson(new URL(`${part}/${list}`, DB_SCHEMA_DIR)) as { tables: ListTable[] };
        for (const table of tables) {
          sealed.push(
            ...table.columns
              .filter((column) => column.sealedBy !== undefined)
              .map((column) => `${table.name}.${column.name}`),
          );
          const named =
            table.primaryKey.length === 1 ||
            JSON.stringify(TWO_COLUMN_KEYS[table.name] ?? null) === JSON.stringify(table.primaryKey);
          if (!table.versioned || !named) {
            leftOutTables.push(table.name);
            continue;
          }
          if (NEVER_SETUP_TABLES.has(table.name)) {
            continue;
          }
          expected[table.name] = {
            part,
            key: table.primaryKey,
            scopedBy:
              table.rowLevelSecurity.scope === "business" ? (table.rowLevelSecurity.column ?? null) : null,
            columns: Object.fromEntries(
              table.columns
                .filter((column) => !NEVER_SETUP_COLUMNS.has(`${table.name}.${column.name}`))
                .filter((column) => !column.type.startsWith("geography"))
                .map((column) => [column.name, column.type]),
            ),
          };
        }
      }
    }
    // The sealed columns the lists name are exactly those never answered as sealed (default 2).
    expect(sealed.sort()).toEqual(
      [
        "calendar_links.tokens",
        "documents.ends",
        "documents.issuer",
        "documents.number",
        "document_files.object_key",
        "document_signatures.typed_name",
        "emergency_contacts.mobile",
        "emergency_contacts.name",
        "id_uploads.object_key",
      ].sort(),
    );
    // The tables with no version or with a key item 77 does not name: none holds a fact.
    expect(leftOutTables.sort()).toEqual(
      [
        "contact_changes",
        "document_files",
        "document_signatures",
        "document_signers",
        "document_texts",
        "id_uploads",
        "item_services",
        "plugin_switches",
        "rule_kinds",
        "staff_skills",
        "trade_facts",
      ].sort(),
    );
    // Every sealed column of a table that holds facts is never one, and the map points are the two of K-23's locations.
    const homeSealed = sealed.filter((name) => Object.hasOwn(expected, name.split(".")[0] ?? ""));
    expect(homeSealed.filter((name) => !NEVER_SETUP_COLUMNS.has(name))).toEqual([]);
    const points: string[] = [];
    for (const [part, lists] of Object.entries(PART_LISTS)) {
      for (const list of lists) {
        const { tables } = readJson(new URL(`${part}/${list}`, DB_SCHEMA_DIR)) as { tables: ListTable[] };
        for (const table of tables) {
          for (const column of table.columns) {
            if (column.type.startsWith("geography")) {
              points.push(`${table.name}.${column.name}`);
            }
          }
        }
      }
    }
    expect(points.sort()).toEqual(["locations.map_point", "locations.travel_centre"]);
    expect(JSON.parse(JSON.stringify(SETUP_FACT_HOMES))).toEqual(expected);
  });
});

// ---- the card's proofs -------------------------------------------------------------------------------------------------

describe("readTurnState with setup facts (T-667)", () => {
  it("runs on the primary", async () => {
    const [row] = await runtime<{ standby: boolean }[]>`select pg_is_in_recovery() as standby`;
    expect(row?.standby).toBe(false);
  });

  it("reads each part's seed row back, every column with its row id and version", SLOW, async () => {
    for (const { part, seed, table } of PART_ROWS) {
      const home = SETUP_FACT_HOMES[table];
      if (home === undefined) {
        throw new Error(`no setup home ${table}`);
      }
      const values = seedRow(part, seed, table);
      const rowId = rowIdOf(home, values);
      const businessId = businessOfRow(home, values);
      const outcome = await readTurnState(runtime, requestOf(businessId, factsOfRow(table, rowId)));
      expect(outcomeErrors(outcome), table).toEqual([]);
      const state = asTurnState(outcome);
      expect(state.businessId, table).toBe(businessId);
      expect(
        state.facts.map((fact) => fact.column),
        table,
      ).toEqual(Object.keys(home.columns));
      for (const fact of state.facts) {
        const what = `${table}.${fact.column}`;
        expect(fact.table, what).toBe(table);
        expect(fact.rowId, what).toBe(rowId);
        expect(fact.key, what).toBe(what);
        expect(fact.version, what).toBe(values.version);
        const type = home.columns[fact.column];
        if (type !== undefined && Object.hasOwn(values, fact.column)) {
          expect(fact.value, what).toEqual(answered(type, values[fact.column] ?? null));
        }
      }
    }
  });

  it(
    "answers notFound under another business's scope, as row-level security shows the row to no other scope",
    SLOW,
    async () => {
      for (const { part, seed, table } of PART_ROWS) {
        const home = SETUP_FACT_HOMES[table];
        // A table scoped none answers by its own rule, which the round 2 tests below hold under each business.
        if (home === undefined || home.scopedBy === null) {
          continue;
        }
        const values = seedRow(part, seed, table);
        const rowId = rowIdOf(home, values);
        const own = businessOfRow(home, values);
        const other = own === YOGA ? BARBERSHOP : YOGA;
        const outcome = await readTurnState(runtime, requestOf(other, factsOfRow(table, rowId)));
        expect(outcome, table).toEqual({ error: "notFound", table, rowId });
        expect(outcomeErrors(outcome), table).toEqual([]);
        // Row-level security alone, with no business named in the read: the row's own scope shows it, another hides it,
        // for the runtime side's role and the Tool API's alike.
        for (const role of ["rosie_job", "rosie_app"]) {
          const count = async (business: string): Promise<number> =>
            withBusiness(db.sql, business, async (tx: Tx) => {
              await tx.unsafe(`set local role ${role}`);
              const [row] = await tx<{ n: number }[]>`
              select count(*)::integer as n from ${tx(table)} where ${rowNameSql(tx, home.key)} = ${rowId}
            `;
              return row?.n ?? -1;
            });
          expect(await count(own), `${role} ${table} own`).toBe(1);
          expect(await count(other), `${role} ${table} other`).toBe(0);
        }
      }
    },
  );

  it(
    "answers a link or a busy block only as K-27's Tool API policies admit it, under a business and with none (round 2)",
    SLOW,
    async () => {
      const busy = (id: string): Values =>
        seedRowWhere("availability", "seed-busy-block.json", "busy_blocks", { id });
      const link = (id: string): Values =>
        seedRowWhere("availability", "seed-calendar-link.json", "calendar_links", { id });
      const photo = "busy-sam-movers-photo-sat-nov-14";
      const rileysBlock = "busy-riley-sat-nov-7";
      const samsBlock = "busy-sam-thu-nov-12";
      const rileysLink = "callink-riley-google";
      const samsLink = "callink-sam-microsoft";
      const cases: Reach[] = [
        yes(MOVERS, "busy_blocks", photo, busy(photo), "the business's own photo block"),
        no(BARBERSHOP, "busy_blocks", photo, "another business's photo block"),
        yes(
          BARBERSHOP,
          "busy_blocks",
          rileysBlock,
          busy(rileysBlock),
          "a block of a link shared live with it",
        ),
        no(HOME_SERVICES, "busy_blocks", rileysBlock, "a block of a link whose share with it has ended"),
        no(YOGA, "busy_blocks", rileysBlock, "a block of a link it has no share of"),
        no(MOVERS, "busy_blocks", samsBlock, "the handle's person's own block, its link not shared with it"),
        yes(
          HOME_SERVICES,
          "busy_blocks",
          samsBlock,
          busy(samsBlock),
          "the handle's person's block, shared live",
        ),
        yes(BARBERSHOP, "calendar_links", rileysLink, link(rileysLink), "a link shared live with it"),
        no(HOME_SERVICES, "calendar_links", rileysLink, "a link whose share with it has ended"),
        no(YOGA, "calendar_links", rileysLink, "a link it has no share of"),
        no(YOGA, "calendar_links", "callink-avery-google", "another person's link it has no share of"),
        yes(
          MOVERS,
          "calendar_links",
          samsLink,
          link(samsLink),
          "the handle's person's own link, shared elsewhere",
        ),
        yes(null, "calendar_links", samsLink, link(samsLink), "the handle's own link, with no business"),
        no(null, "calendar_links", rileysLink, "another person's link, with no business, though shared"),
        no(null, "busy_blocks", samsBlock, "the handle's person's own block, with no business"),
        no(null, "busy_blocks", photo, "a photo block, with no business"),
      ];
      for (const reach of cases) {
        await expectReach(reach);
        // The Tool API's select policy, acting for the handle's one person, admits exactly the same rows.
        expect(await toolApiSees(reach.businessId, reach.table, reach.rowId), reach.why).toBe(
          reach.seed !== null,
        );
      }
      // A link's tokens are never a fact, whoever reads it.
      expect(
        await readTurnState(
          runtime,
          requestOf(BARBERSHOP, [
            { key: "tokens", table: "calendar_links", rowId: rileysLink, column: "tokens" },
          ]),
        ),
      ).toEqual({ error: "unknownFact", key: "tokens", table: "calendar_links", column: "tokens" });
    },
  );

  it(
    "answers a code, a session or an account only of the handle's people, a code only with no business or the request's (round 2)",
    SLOW,
    async () => {
      // handle-sam's one person, as item 26 reads the handle's people.
      const sam = asTurnState(await readTurnState(runtime, requestOf(null, [])));
      expect(sam.persons.map((person) => person.personId)).toEqual(["person-sam"]);
      const code = (id: string): Values =>
        seedRowWhere("people-access", "seed-proof-code.json", "proof_codes", { id });
      const session = (id: string): Values =>
        seedRowWhere("people-access", "seed-session.json", "sessions", { id });
      const account = seedRowWhere("people-access", "seed-owner-id-upload.json", "accounts", {
        person_id: "person-sam",
      });
      const ownerEmail = "code-sam-owner-email";
      const signIn = "code-sam-sign-in-oct26";
      const live = "session-sam-oct26";
      const ended = "session-sam-oct20";
      const cases: Reach[] = [
        yes(BARBERSHOP, "proof_codes", ownerEmail, code(ownerEmail), "the person's code of the business"),
        no(HOME_SERVICES, "proof_codes", ownerEmail, "the person's code of another business"),
        yes(HOME_SERVICES, "proof_codes", signIn, code(signIn), "the person's code with no business"),
        no(BARBERSHOP, "proof_codes", "code-jordan-sign-in-paused", "another person's code"),
        no(BARBERSHOP, "proof_codes", "code-tester-one-sign-in", "another person's code, with no business"),
        no(BARBERSHOP, "proof_codes", CONTROL_CODE, "the business's own control code, which has no person"),
        no(HOME_SERVICES, "proof_codes", CONTROL_CODE, "another business's control code"),
        yes(BARBERSHOP, "sessions", live, session(live), "the person's live session"),
        yes(YOGA, "sessions", ended, session(ended), "the person's ended session, under any business"),
        no(BARBERSHOP, "sessions", "session-tester-one", "another person's session"),
        yes(BARBERSHOP, "accounts", "person-sam", account, "the person's account"),
        yes(YOGA, "accounts", "person-sam", account, "the person's account, under any business"),
        no(BARBERSHOP, "accounts", "person-tester-one", "another person's account"),
        yes(null, "proof_codes", signIn, code(signIn), "the person's code with no business, with none"),
        no(null, "proof_codes", ownerEmail, "the person's code of a business, with no business"),
        no(null, "proof_codes", CONTROL_CODE, "a control code, with no business"),
        yes(null, "sessions", live, session(live), "the person's session, with no business"),
        no(null, "sessions", "session-tester-one", "another person's session, with no business"),
        yes(null, "accounts", "person-sam", account, "the person's account, with no business"),
        no(null, "accounts", "person-tester-one", "another person's account, with no business"),
      ];
      for (const reach of cases) {
        await expectReach(reach);
        // Never a row the Tool API's select policy would not show the handle's person (K-22 rule 5; it has no grant on
        // accounts).
        if (reach.seed !== null && reach.table !== "accounts") {
          expect(await toolApiSees(reach.businessId, reach.table, reach.rowId), reach.why).toBe(true);
        }
      }
      // The hash columns stay unknown facts, of the person's own rows too.
      for (const [table, rowId, column] of [
        ["proof_codes", ownerEmail, "code_hash"],
        ["sessions", live, "token_sha256"],
        ["sessions", live, "device_sha256"],
      ] as const) {
        expect(
          await readTurnState(runtime, requestOf(BARBERSHOP, [{ key: "hash", table, rowId, column }])),
        ).toEqual({ error: "unknownFact", key: "hash", table, column });
      }
    },
  );

  it(
    "names a two-column row by item 77's name, compared whole: never by its kind alone, never another business's",
    SLOW,
    async () => {
      const kind = (rowId: string, businessId: string | null): Promise<SetupTurnStateOutcome> =>
        readTurnState(
          runtime,
          requestOf(businessId, [{ key: "kind.version", table: "company_kinds", rowId, column: "version" }]),
        );
      const plumbing = asTurnState(await kind("company-lee-home-services/plumber", HOME_SERVICES));
      expect(plumbing.facts).toEqual([
        {
          key: "kind.version",
          table: "company_kinds",
          rowId: "company-lee-home-services/plumber",
          column: "version",
          value: 1,
          version: 1,
        },
      ]);
      for (const [rowId, businessId] of [
        ["company-lee-home-services/plumber", BARBERSHOP],
        ["plumber", HOME_SERVICES],
        ["company-lee-home-services", HOME_SERVICES],
        ["company-lee-home-services/plumber/", HOME_SERVICES],
        ["company-lee-home-services/Plumber", HOME_SERVICES],
      ] as const) {
        expect(await kind(rowId, businessId), rowId).toEqual({
          error: "notFound",
          table: "company_kinds",
          rowId,
        });
      }
      // The shared catalog's kind_flows (scope none) by its name under any business.
      const barberA = seedRowWhere("kinds-of-work", "seed-kinds-sample.json", "kind_flows", {
        kind_id: "barber",
        flow: "A",
      });
      const flows = asTurnState(
        await readTurnState(
          runtime,
          requestOf(YOGA, [{ key: "barber.a", table: "kind_flows", rowId: "barber/A", column: "combos" }]),
        ),
      ).facts;
      expect(flows.map((fact) => [fact.rowId, fact.value, fact.version])).toEqual([
        ["barber/A", barberA.combos, barberA.version],
      ]);
      // A flow default by business/flow, under its own business only.
      expect(
        await readTurnState(
          runtime,
          requestOf(YOGA, [
            { key: "cutoff", table: "flow_defaults", rowId: `${BARBERSHOP}/A`, column: "cutoff_before" },
          ]),
        ),
      ).toEqual({ error: "notFound", table: "flow_defaults", rowId: `${BARBERSHOP}/A` });
    },
  );

  it("reads a flow default's interval as whole minutes, under its own business", SLOW, async () => {
    const state = asTurnState(
      await readTurnState(
        runtime,
        requestOf(BARBERSHOP, [
          { key: "a.cutoff", table: "flow_defaults", rowId: `${BARBERSHOP}/A`, column: "cutoff_before" },
          { key: "b.arrive", table: "flow_defaults", rowId: `${BARBERSHOP}/B`, column: "arrive" },
        ]),
      ),
    );
    expect(state.facts.map((fact) => [fact.rowId, fact.value, fact.version])).toEqual([
      [`${BARBERSHOP}/A`, "1440 minutes", 1],
      [`${BARBERSHOP}/B`, "setstart", 1],
    ]);
  });

  it(
    "reads, with no business, the rows with none: a kind placed before its business, never a business's row",
    SLOW,
    async () => {
      const early = asTurnState(
        await readTurnState(
          runtime,
          requestOf(null, [
            {
              key: "early.kind",
              table: "company_kinds",
              rowId: "company-sam-before-business/plumber",
              column: "trade_name",
            },
            { key: "catalog", table: "kinds", rowId: "plumber", column: "pattern" },
          ]),
        ),
      );
      const plumber = seedRowWhere("kinds-of-work", "seed-kinds-sample.json", "kinds", { id: "plumber" });
      expect(early.facts.map((fact) => [fact.rowId, fact.value, fact.version])).toEqual([
        ["company-sam-before-business/plumber", "Lee Plumbing", 1],
        ["plumber", plumber.pattern, plumber.version],
      ]);
      expect(
        await readTurnState(
          runtime,
          requestOf(null, [{ key: "setup", table: "business_setup", rowId: BARBERSHOP, column: "no_money" }]),
        ),
      ).toEqual({ error: "notFound", table: "business_setup", rowId: BARBERSHOP });
      // A business's scope never shows the kind with no business.
      expect(
        await readTurnState(
          runtime,
          requestOf(HOME_SERVICES, [
            {
              key: "early.kind",
              table: "company_kinds",
              rowId: "company-sam-before-business/plumber",
              column: "trade_name",
            },
          ]),
        ),
      ).toEqual({ error: "notFound", table: "company_kinds", rowId: "company-sam-before-business/plumber" });
    },
  );

  it(
    "answers core and setup facts together in the request's order, the first missing in that order",
    SLOW,
    async () => {
      const mixed = asTurnState(
        await readTurnState(
          runtime,
          requestOf(BARBERSHOP, [
            { key: "money", table: "business_setup", rowId: BARBERSHOP, column: "no_money" },
            { key: "zone", table: "businesses", rowId: BARBERSHOP, column: "time_zone" },
            { key: "haircut", table: "services", rowId: "svc-lees-haircut", column: "length" },
          ]),
        ),
      );
      const haircut = seedRowWhere("services-prices", "seed-services-price-list.json", "services", {
        id: "svc-lees-haircut",
      });
      expect(mixed.facts.map((fact) => [fact.key, fact.value, fact.version])).toEqual([
        ["money", false, 4],
        ["zone", "America/New_York", 3],
        ["haircut", "30 minutes", haircut.version],
      ]);
      const setupFirst = await readTurnState(
        runtime,
        requestOf(BARBERSHOP, [
          { key: "gone", table: "services", rowId: "svc-not-there", column: "name" },
          { key: "zone", table: "businesses", rowId: YOGA, column: "time_zone" },
        ]),
      );
      expect(setupFirst).toEqual({ error: "notFound", table: "services", rowId: "svc-not-there" });
      const coreFirst = await readTurnState(
        runtime,
        requestOf(BARBERSHOP, [
          { key: "zone", table: "businesses", rowId: YOGA, column: "time_zone" },
          { key: "gone", table: "services", rowId: "svc-not-there", column: "name" },
        ]),
      );
      expect(coreFirst).toEqual({ error: "notFound", table: "businesses", rowId: YOGA });
      // The handle, the business and a booking come before any fact.
      expect(
        await readTurnState(runtime, {
          ...requestOf(BARBERSHOP, [
            { key: "gone", table: "services", rowId: "svc-not-there", column: "name" },
          ]),
          handleId: "handle-not-there",
        }),
      ).toEqual({ error: "notFound", table: "handles", rowId: "handle-not-there" });
      expect(
        await readTurnState(
          runtime,
          requestOf(
            BARBERSHOP,
            [{ key: "gone", table: "services", rowId: "svc-not-there", column: "name" }],
            ["booking-not-there"],
          ),
        ),
      ).toEqual({ error: "notFound", table: "bookings", rowId: "booking-not-there" });
    },
  );

  it("answers unknownFact, with nothing read, for a hash, a sealed column, a map point, a table never read or none", async () => {
    for (const [table, column] of [
      ["proof_codes", "code_hash"],
      ["sessions", "token_sha256"],
      ["page_links", "code_sha256"],
      ["emergency_contacts", "name"],
      ["calendar_links", "tokens"],
      ["documents", "number"],
      ["locations", "map_point"],
      ["sign_in_attempts", "id"],
      ["staging_testers", "person_id"],
      ["item_services", "service_id"],
      ["trade_facts", "name"],
      ["services", "not_a_column"],
      ["no_such_table", "id"],
    ] as const) {
      // The handle does not exist, so any read would have answered notFound for it.
      const outcome = await readTurnState(runtime, {
        handleId: "handle-not-there",
        businessId: BARBERSHOP,
        bookingIds: [],
        facts: [
          { key: "fine", table: "services", rowId: "svc-lees-haircut", column: "name" },
          { key: "refused", table, rowId: "x", column },
        ],
      });
      expect(outcome, `${table}.${column}`).toEqual({ error: "unknownFact", key: "refused", table, column });
    }
  });

  it("refuses a request out of shape before the database is reached", async () => {
    await expect(
      readTurnState(runtime, {
        ...requestOf(BARBERSHOP, []),
        extra: true,
      } as unknown as ReadTurnStateRequest),
    ).rejects.toThrow(TypeError);
    await expect(
      readTurnState(
        runtime,
        requestOf(BARBERSHOP, [{ key: "", table: "services", rowId: "svc-lees-haircut", column: "name" }]),
      ),
    ).rejects.toThrow(TypeError);
  });

  it("readTurnStateIn refuses a transaction that is not under the request's business", SLOW, async () => {
    await expect(
      db.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${RUNTIME_ROLE}`);
        return readTurnStateIn(tx, requestOf(BARBERSHOP, factsOfRow("services", "svc-lees-haircut")));
      }),
    ).rejects.toThrow(/business scope/);
  });

  it(
    "reads the K-23 v1.1 claim as two facts as rosie_job (K-05 v1.24 item 87; T-1561): a claim on file with its person and version, a row with none as two nulls, another business's row never",
    SLOW,
    async () => {
      const [who] = await runtime<{ role: string }[]>`select current_user as role`;
      expect(who?.role).toBe(RUNTIME_ROLE);
      const claim = (businessId: string): FactRef[] => [
        { key: "claim", table: "business_setup", rowId: businessId, column: "signup_claim" },
        { key: "claimedBy", table: "business_setup", rowId: businessId, column: "claimed_by_person_id" },
      ];
      // The movers' setup row as S1-09's writer inserts it with an owner's claim (K-05 v1.24 item 87, card B15: in the
      // insert when no row is on file), written here by the tables' owner and removed when the case ends.
      await db.sql`
        insert into business_setup (business_id, signup_claim, claimed_by_person_id)
        values (${MOVERS}, 'owner', 'person-sam')
      `;
      try {
        const claimed = await readTurnState(runtime, requestOf(MOVERS, claim(MOVERS)));
        expect(outcomeErrors(claimed)).toEqual([]);
        expect(
          asTurnState(claimed).facts.map((fact) => [
            fact.key,
            fact.table,
            fact.rowId,
            fact.value,
            fact.version,
          ]),
        ).toEqual([
          ["claim", "business_setup", MOVERS, "owner", 1],
          ["claimedBy", "business_setup", MOVERS, "person-sam", 1],
        ]);
        // The barbershop's seed row keeps no claim: both facts null, at the row's version.
        const unclaimed = await readTurnState(runtime, requestOf(BARBERSHOP, claim(BARBERSHOP)));
        expect(outcomeErrors(unclaimed)).toEqual([]);
        expect(asTurnState(unclaimed).facts.map((fact) => [fact.key, fact.value, fact.version])).toEqual([
          ["claim", null, 4],
          ["claimedBy", null, 4],
        ]);
        // Under another business, or with none, the movers' row is not found.
        expect(await readTurnState(runtime, requestOf(YOGA, claim(MOVERS)))).toEqual({
          error: "notFound",
          table: "business_setup",
          rowId: MOVERS,
        });
        expect(await readTurnState(runtime, requestOf(null, claim(MOVERS)))).toEqual({
          error: "notFound",
          table: "business_setup",
          rowId: MOVERS,
        });
      } finally {
        await db.sql`delete from business_setup where business_id = ${MOVERS}`;
      }
    },
  );
});
