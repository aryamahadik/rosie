// Contract test for K-05 v1.18, the catalog's five reads: the database side (T-1434; T-1428's db/repo/catalog-reads.ts;
// T-1427's handoff and the database engineer's review N4; DL-888, DL-903, DL-911, DL-927; contracts/data-access/README.md
// section "v1.18", items 72 to 77, defaults 152 to 166, "Consumers of v1.18", and "Fixtures", v1.18).
//
// The fixture part, data-access.v1.test.ts with data-access.v1.18.test.ts, checks every v1.18 fixture against the
// schema of v1.18. This part is the producer's side (C-152) of v1.18: the database engineer's five reads (T-1428,
// db/repo/catalog-reads.ts: readBusinessKinds, readBusinessServices, readServiceWays, readServicePriceRules and
// readTermsSources, README items 72 to 76). Every entry of fixtures/index.json whose version is one of DB_SIDE_VERSIONS
// runs here, selected by its version, never by a pinned list or count (DL-124, DL-125), against local PostgreSQL with
// every migration applied to a fresh schema (db/repo/test-db.ts), each read through the Tool API's role, rosie_app, as
// the README gives every v1.18 call (README "The calls v1.18 adds", default 154):
//   - each accepted exchange: its given is loaded as the tables' owner (its k04Seeds and partSeeds, each with its own
//     after chain, each file once; a K-26 registry row a chain names, seed-rule-registry.json's through K-26's
//     seed-rules-tap-list, is found stored as migration 0023 wrote it and never inserted, as db/repo's rules.int.test.ts
//     finds it: REGISTRY_KEYS; then the rows its note lists, where no frozen seed holds them: NOTED_ROWS,
//     read-price-rules-haircut-tie's evening price and its tie, written first, in the note's order and with its
//     values); then its request goes through the db/repo read it names, in that read's own read-only transaction, at
//     given.now (the database's now() the README's fixtures fix). The answer is the fixture's outcome, whole, valid at
//     v1.18 as the call's response or one of its errors, the exchange with it valid too: the seeds answered;
//   - nothing under another business: in each accepted exchange's world, the same request made for every other business
//     the world holds answers none of the exchange's business's rows: every row it gives is that other business's, and
//     none is one the exchange's answer gives (default 154; README "The calls v1.18 adds": "a row of another business
//     is never answered, not even counted");
//   - each refused request (REQUEST_TWINS: no business, no service, a time with a zone offset, a flow named): db/repo
//     refuses it before any statement reaches the database, in its own given, which is its twin's; and with its one
//     fault taken out, its twin's request, db/repo answers it the outcome the two fixtures share;
//   - each refused answer (RESPONSE_TWINS: a kind named by its id alone, a setup with its listing phone, a service with
//     its extras, a span as interval text, a rule with its words): in its twin's state db/repo's answer is valid against
//     the refused fixture's own definition, which refuses the fixture, and differs from it only at the fault the fixture
//     carries: the repo answers it put right, never as it stands.
// So a read of db/repo that drifts from the frozen contract fails this test. The repo's own test
// (db/repo/catalog-reads.int.test.ts, T-1428) holds the rest of the producer's side: every statement's tables and
// columns, the business named beside every business-scoped table, row-level security alone, the In forms, one moment per
// read, and the stored values no fixture shows (spans, clock times, names and cents the answer cannot carry).
//
// It needs PostgreSQL: `npm run db:up` locally (DATABASE_URL, else the local Docker database when CI is unset), and the
// merge check's service database (DATABASE_URL) in CI.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readBusinessKinds,
  readBusinessServices,
  readServicePriceRules,
  readServiceWays,
  readTermsSources,
} from "../../db/repo/catalog-reads";
import type { Sql, Tx } from "../../db/repo/scope";
import type { ReadOptions } from "../../db/repo/targets";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { CONTRACTS_ROOT, type FixtureEntry } from "./_harness";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
const DB_SCHEMA_DIR = path.join(CONTRACTS_ROOT, "db-schema");
const CORE_SEEDS_DIR = path.join(DB_SCHEMA_DIR, "core", "fixtures");
const SLOW = { timeout: 60_000 };

/**
 * The versions with a database side here: v1.18 (T-1428). Its five reads load seeds that data-access.v1.db-side.test.ts
 * cannot: their chains name K-26's registry rows, which only migration 0023's seed writes and a loader finds, never
 * inserts (T-1427's database review N4), and K-24's catalog of kinds, which that file's reset leaves, so v1.18's
 * database side is this file of its own, with its own loader, as T-1434's card gives it ("data-access.v1.18*.test.ts").
 */
const DB_SIDE_VERSIONS = ["v1.18"];

interface Given {
  k04Seeds: string[];
  partSeeds?: string[];
  after: string[];
  now: string;
  note?: string;
}

interface Exchange {
  call: string;
  given: Given;
  request: Record<string, Json>;
  outcome: Record<string, Json>;
}

interface SeedRow {
  table: string;
  values: Record<string, Json>;
}

interface SeedFile {
  after: string[];
  rows: SeedRow[];
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an answer is one of its call's errors. */
const isError = (answer: unknown): boolean => isRecord(answer) && "error" in answer;

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
const entryOf = (file: string): FixtureEntry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry ${file}`,
  );
/** Every entry of a version with a database side, in the index's order. */
const sideEntries = entries.filter((entry) => DB_SIDE_VERSIONS.includes(entry.version));
const sideAccepted = sideEntries.filter((entry) => entry.expect === "accept");
const sideRefused = sideEntries.filter((entry) => entry.expect === "refuse");

/** A fresh copy of a fixture of this folder. */
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;

/** `<call>.<part>`: the call a definition belongs to, and its part (exchange, response). */
function defOf(entry: FixtureEntry): { call: string; part: string } {
  const def = must(entry.def, `${entry.file}'s def`);
  const dot = def.lastIndexOf(".");
  if (dot < 1) throw new Error(`${entry.file}: ${def} is no <call>.<part> definition`);
  return { call: def.slice(0, dot), part: def.slice(dot + 1) };
}

// ---------------------------------------------------------------------------------------------------------------
// The schemas: every schema under contracts/, as contracts:check loads them, so each $ref resolves; one strict
// validator (Ajv 2020-12), each definition taken from the schema of the version an entry lists

const SKIPPED = new Set(["node_modules", "generated"]);

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : schemaFiles(full);
    return entry.isFile() && entry.name.endsWith(".schema.json") ? [full] : [];
  });
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS_ROOT)) ajv.addSchema(readJson(file) as object);

const idOf = (version: string): string =>
  (readJson(path.join(DATA_ACCESS_DIR, `data-access.${version}.schema.json`)) as { $id: string }).$id;

/** The validator of one definition of a version's schema. */
function validatorOf(version: string, def: string): ValidateFunction {
  const key = `${idOf(version)}#/$defs/${def}`;
  return must(ajv.getSchema(key), `the schema ${key}`);
}

/** Ajv's errors as one line each; none when `value` is valid. */
function errorsOf(validate: ValidateFunction, value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? ""}`);
}

/** An answer against its call's errors when it is one, else its call's response, at `version`. */
function answerErrors(version: string, call: string, answer: unknown): string[] {
  return errorsOf(validatorOf(version, `${call}.${isError(answer) ? "errors" : "response"}`), answer);
}

// ---------------------------------------------------------------------------------------------------------------
// Each read through db/repo, as the Tool API's role

type Read = (sql: Sql, request: never, options: ReadOptions) => Promise<unknown>;

/**
 * The five calls v1.18 adds (README "The calls v1.18 adds", items 72 to 76), each db/repo's read in a read-only
 * transaction of its own on the client it is given: here the Tool API's, rosie_app, under the request's own business
 * (default 154), which the read sets and confirms with requireBusinessScope() before its first table.
 */
const DB_CALLS: Readonly<Record<string, Read>> = {
  readBusinessKinds,
  readBusinessServices,
  readServiceWays,
  readServicePriceRules,
  readTermsSources,
};

/** The role every v1.18 read runs as (README "The calls v1.18 adds": "as the Tool API's role, rosie_app"). */
const APP_ROLE = "rosie_app";

const callOf = (call: string): Read => must(DB_CALLS[call], `a db/repo read for ${call}`);

/**
 * Each refused answer of v1.18 with its twin: the accepted exchange that answers the same read, whose state and request
 * this test gives db/repo; and `faults`, the places the refused fixture carries its fault (README "Fixtures", v1.18:
 * "twin `read-business-kinds-lee-home-services`, its outcome").
 */
const RESPONSE_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // Lee Plumbing named by its kind's id alone; item 77 names a company_kinds row by its company and its kind
  "invalid/refuse-business-kinds-row-by-kind-id.json": {
    twin: "read-business-kinds-lee-home-services.json",
    faults: ["kinds.1.rowId"],
  },
  // The barbershop's setup with its listing phone; read 1 answers no_money alone of that row
  "invalid/refuse-business-kinds-setup-listing-phone.json": {
    twin: "read-business-kinds-barbershop.json",
    faults: ["setup.listingPhone"],
  },
  // The wiring repair with its extras, which no code reads
  "invalid/refuse-business-services-with-extras.json": {
    twin: "read-business-services-lee-home-services.json",
    faults: ["services.0.extras"],
  },
  // The skin fade's free-cancel time as the interval text '2 hours'; a span is whole minutes
  "invalid/refuse-service-ways-cutoff-as-interval.json": {
    twin: "read-service-ways-skin-fade.json",
    faults: ["ways.0.cutoffBeforeMinutes"],
  },
  // The kids-cut note with Sam's words; a rule is answered by its kind, scope, value and dates
  "invalid/refuse-terms-sources-rule-with-words.json": {
    twin: "read-terms-sources-dee-skin-fade.json",
    faults: ["rules.0.words"],
  },
};

/**
 * Each refused exchange of v1.18, whose one fault is its request, with its twin: the accepted exchange whose given and
 * outcome it shares, and whose request it is with the fault taken out (README "Fixtures", v1.18: "twin
 * `read-business-kinds-barbershop`, its request"); and `faults`, the places of the refused request that carry its one
 * fault. db/repo refuses such a request before any statement reaches the database.
 */
const REQUEST_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // A kinds read with businessId null: a catalog read is the call's own business's, never null (default 154)
  "invalid/refuse-business-kinds-no-business.json": {
    twin: "read-business-kinds-barbershop.json",
    faults: ["businessId"],
  },
  // A ways read naming no service
  "invalid/refuse-service-ways-no-service.json": {
    twin: "read-service-ways-haircut.json",
    faults: ["serviceId"],
  },
  // A rules read at a time with a zone offset; every instant is UTC ending in Z
  "invalid/refuse-price-rules-at-with-offset.json": {
    twin: "read-price-rules-haircut-before-raise.json",
    faults: ["at"],
  },
  // A sources read naming a flow; the read answers both flows' defaults (default 158)
  "invalid/refuse-terms-sources-caller-flow.json": {
    twin: "read-terms-sources-dee-skin-fade.json",
    faults: ["flow"],
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Comparing a refused answer with db/repo's

/** The dotted paths at which two JSON values differ, under `at`; an array whose length changed differs as a whole. */
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const inside = (step: string | number): string => (at === "" ? String(step) : `${at}.${String(step)}`);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((item: unknown, place) => differences(item, b[place], inside(place)));
  }
  if (isRecord(a) && isRecord(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      differences(a[key], b[key], inside(key)),
    );
  }
  return [at];
}

/** Whether a place is the field at `at` or inside it. */
const within = (place: string, at: string): boolean => place === at || place.startsWith(`${at}.`);

/**
 * Each way db/repo's answer fails to be the refused answer put right, none when it is: they differ, and only at the
 * refused fixture's faults, and each fault is a place they differ.
 */
export function twinProblems(
  refused: unknown,
  answer: unknown,
  twin: { faults: readonly string[] },
): string[] {
  const differ = differences(refused, answer);
  const problems: string[] = [];
  if (differ.length === 0) problems.push("db/repo answers the refused fixture as it stands");
  for (const place of differ) {
    if (!twin.faults.some((fault) => within(place, fault))) {
      problems.push(`db/repo's answer differs at ${place}, which is not the fault`);
    }
  }
  for (const fault of twin.faults) {
    if (!differ.some((place) => within(place, fault) || within(fault, place))) {
      problems.push(`the fault ${fault} is not where db/repo's answer differs`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The rows a fixture's note says its database side writes itself (README "Fixtures", v1.18)

/** v1.18's tie fixture, whose note lists the two rows its database side writes before the read. */
const TIE_FIXTURE = "read-price-rules-haircut-tie.json";

/** Sam's evening price on the haircut and its tie with the home price, as the tie fixture's note gives them. */
const EVENING = {
  ruleId: "price-lees-haircut-evening",
  tieId: "tie-lees-haircut-home-evening",
  business: "biz-lees-barbershop",
  service: "svc-lees-haircut",
  homeRule: "price-lees-haircut-home",
  fromTime: "17:00",
  priceCents: 4500,
  currency: "USD",
  setBy: "person-sam",
  from: "2026-11-03T15:00:00Z",
  version: 1,
} as const;

/** The tie fixture's two rows, in its note's order: the evening price, then the tie that names it. */
function tieRows(): SeedRow[] {
  return [
    {
      table: "price_rules",
      values: {
        id: EVENING.ruleId,
        business_id: EVENING.business,
        service_id: EVENING.service,
        service_money_id: null,
        worker_resource_id: null,
        weekdays: null,
        from_time: EVENING.fromTime,
        until_time: null,
        price_cents: EVENING.priceCents,
        from_cents: null,
        currency: EVENING.currency,
        set_by_person_id: EVENING.setBy,
        effective_from: EVENING.from,
        effective_to: null,
        version: EVENING.version,
      },
    },
    {
      table: "price_rule_ties",
      values: {
        id: EVENING.tieId,
        business_id: EVENING.business,
        service_id: EVENING.service,
        first_rule_id: EVENING.homeRule,
        second_rule_id: EVENING.ruleId,
        asked_at: EVENING.from,
        winner_rule_id: null,
        answered_at: null,
        answered_by_person_id: null,
        version: EVENING.version,
      },
    },
  ];
}

/** How the tie fixture's note lists its two rows, in its own words and order, value for value. */
const TIE_NOTE_PHRASES = [
  `price_rules ${EVENING.ruleId} (business ${EVENING.business}, service ${EVENING.service}, no place or worker, every ` +
    `day, from ${EVENING.fromTime} with no end time, ${String(EVENING.priceCents)} cents in ${EVENING.currency}, set ` +
    `by ${EVENING.setBy}, effective from ${EVENING.from} and open, version ${String(EVENING.version)})`,
  `price_rule_ties ${EVENING.tieId} (business ${EVENING.business}, service ${EVENING.service}, first rule ` +
    `${EVENING.homeRule}, second rule ${EVENING.ruleId}, asked at ${EVENING.from}, not answered, version ` +
    `${String(EVENING.version)})`,
];

/** By fixture, the rows its note says its database side writes itself, in its order (no frozen seed holds a tie). */
const NOTED_ROWS: Readonly<Record<string, () => SeedRow[]>> = {
  [TIE_FIXTURE]: tieRows,
};

const notedRowsOf = (file: string): SeedRow[] => NOTED_ROWS[file]?.() ?? [];

// ---------------------------------------------------------------------------------------------------------------
// The database

let db: TestDatabase;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
let typedColumns: Map<string, string>;
/** Every statement the role client sent, in order (postgres.js debug: the text, never the values). */
const sent: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase({ name: "data_access_v118_db_side" });
  app = db.connect({
    max: 2,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: { application_name: "rosie-t1434-app", search_path: `${db.schema}, public`, role: APP_ROLE },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 120_000);

afterAll(async () => {
  await app.end({ timeout: 5 });
  await db.drop();
});

/**
 * Empties every table the seeds write (truncating the heads, and K-24's catalog of kinds, cascades to the rest; this
 * file's schema only). K-26's registries refer to no head, so migration 0023's seed of them stays.
 */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags, kinds restart identity cascade`;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** One seed row, its jsonb values as JSON and its bytea values as the bytes their hex names. */
async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) converted = sql.json(value);
    else if (type === "bytea" && typeof value === "string") converted = fromHex(value.replace(/^\\x/, ""));
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it, each file once. */
function seedRows(file: string, seen: Set<string>): SeedRow[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const seed = readJson(file) as SeedFile;
  return [
    ...seed.after.flatMap((before) => seedRows(path.join(path.dirname(file), before), seen)),
    ...seed.rows,
  ];
}

/** `<part>/<file>`, a seed of another database part (README "Fixtures", given.partSeeds), in that part's fixtures. */
function partSeedFile(name: string): string {
  const slash = name.indexOf("/");
  if (slash < 1) throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  return path.join(DB_SCHEMA_DIR, name.slice(0, slash), "fixtures", ...name.slice(slash + 1).split("/"));
}

/** The seed files a fixture's given names: K-04's, then the other parts'. */
const seedFilesOf = (state: Given): string[] => [
  ...state.k04Seeds.map((seed) => path.join(CORE_SEEDS_DIR, seed)),
  ...(state.partSeeds ?? []).map(partSeedFile),
];

/** A fixture's seed rows, its chains' first, each file once. */
const worldRowsOf = (state: Given): SeedRow[] => {
  const seen = new Set<string>();
  return seedFilesOf(state).flatMap((file) => seedRows(file, seen));
};

/** K-26's closed registries and their keys: only a migration's seed writes them (K-26 rule 5). */
const REGISTRY_KEYS: ReadonlyMap<string, string> = new Map([
  ["trade_facts", "name"],
  ["plugin_switches", "name"],
  ["rule_kinds", "id"],
]);

/**
 * A registry row a seed chain names, found as the tables' owner stored as migration 0023's seed wrote it, every column
 * the seed gives as it gives it; never inserted (T-1427's database review N4; db/repo/rules.int.test.ts expectStored).
 */
async function lookUpRegistryRow(sql: Db, row: SeedRow, key: string): Promise<void> {
  const name = row.values[key];
  if (typeof name !== "string") throw new Error(`a ${row.table} seed row names no ${key}`);
  const found = await sql<{ stored: Record<string, Json> }[]>`
    select to_jsonb(r) as stored from ${sql(row.table)} r where ${sql(key)} = ${name}
  `;
  if (found.length !== 1) throw new Error(`${row.table} ${name}: migration 0023's seed does not hold it`);
  const stored = must(found[0]).stored;
  for (const [column, value] of Object.entries(row.values)) {
    if (!isDeepStrictEqual(stored[column], value)) {
      throw new Error(`${row.table} ${name}: ${column} is not stored as the seed gives it`);
    }
  }
}

/** Every registry's row count, as the tables' owner. */
async function registryCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of REGISTRY_KEYS.keys()) {
    const [row] = await db.sql<{ rows: number }[]>`select count(*)::int as rows from ${db.sql(table)}`;
    counts[table] = row?.rows ?? -1;
  }
  return counts;
}

/**
 * Loads a fixture's given into the emptied schema, as the tables' owner, in one transaction: its seeds and their
 * chains, each file once, each registry row found as the migration wrote it and never inserted (REGISTRY_KEYS), then
 * the rows its note lists (NOTED_ROWS), in the note's order. A v1.18 read writes nothing, so no exchange runs first.
 */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  if (exchange.given.after.length > 0) throw new Error(`${file}: a v1.18 read runs after no exchange`);
  await reset();
  const rows = [...worldRowsOf(exchange.given), ...notedRowsOf(file)];
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      const key = REGISTRY_KEYS.get(row.table);
      if (key === undefined) await insertRow(tx, row.table, row.values);
      else await lookUpRegistryRow(tx, row, key);
    }
  });
  return exchange;
}

/** The exchange's request through its db/repo read, as rosie_app, in the read's own transaction, at given.now. */
async function runExchange(exchange: Exchange): Promise<unknown> {
  return callOf(exchange.call)(app, structuredClone(exchange.request) as never, {
    now: new Date(exchange.given.now),
  });
}

/** Every business the loaded world holds, as the tables' owner, in byte order. */
async function businessesOfWorld(): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`select id from businesses order by id collate "C"`;
  return rows.map((row) => row.id);
}

/**
 * The rows an answer holds that are a business's, never the request it echoes: each element of its lists, and its
 * setup row, that names a business (a kind's kind_flows rows are K-24's shared catalog's, which no business holds).
 */
function businessRowsOf(answer: unknown): Record<string, unknown>[] {
  if (!isRecord(answer)) return [];
  const lists = Object.values(answer).filter((value): value is unknown[] => Array.isArray(value));
  return [answer.setup, ...lists.flat()].filter(
    (row): row is Record<string, unknown> => isRecord(row) && Object.hasOwn(row, "businessId"),
  );
}

/** A business's row's name in an answer: its id, or its item 77 name; a setup row by its business. */
const rowNameOf = (row: Record<string, unknown>): string => String(row.id ?? row.rowId ?? row.businessId);

/**
 * Each way an answer for `other` holds a row of the business whose answer `theirs` is, none when it holds none: every
 * row it gives is `other`'s, none is one `theirs` gives, and none names `business`.
 */
export function otherBusinessProblems(
  answer: unknown,
  other: string,
  business: string,
  theirs: unknown,
): string[] {
  const problems: string[] = [];
  const rows = businessRowsOf(answer);
  const names = new Set(businessRowsOf(theirs).map(rowNameOf));
  for (const row of rows) {
    if (row.businessId !== other)
      problems.push(`${rowNameOf(row)} is ${String(row.businessId)}'s, not ${other}'s`);
    if (row.businessId !== business && names.has(rowNameOf(row))) {
      problems.push(`${rowNameOf(row)} is a row ${business}'s answer gives`);
    }
  }
  if (JSON.stringify(rows).includes(`"${business}"`)) problems.push(`a row names ${business}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

describe("data-access v1.18 database side: the versions with one, each entry selected by its version", () => {
  it("runs every entry of v1.18, accepted and refused, each against a db/repo read the README names", () => {
    for (const version of DB_SIDE_VERSIONS) {
      const ofVersion = sideEntries.filter((entry) => entry.version === version);
      expect(
        ofVersion.filter((entry) => entry.expect === "accept").length,
        `${version}: accepted`,
      ).toBeGreaterThan(0);
      expect(
        ofVersion.filter((entry) => entry.expect === "refuse").length,
        `${version}: refused`,
      ).toBeGreaterThan(0);
    }
    const calls = new Set(sideEntries.map((entry) => defOf(entry).call));
    expect([...calls].sort()).toEqual(Object.keys(DB_CALLS).sort());
    for (const entry of sideAccepted) {
      expect(defOf(entry).part, entry.file).toBe("exchange");
      expect(exchangeOf(entry.file).call, entry.file).toBe(defOf(entry).call);
      expect(exchangeOf(entry.file).given.after, `${entry.file}: no exchange runs first`).toEqual([]);
    }
  });

  it("has a twin for every refused fixture, and for no other file: an answer by its response, a request by its exchange, each twin an accepted exchange of its call", () => {
    const answers = sideRefused
      .filter((entry) => defOf(entry).part === "response")
      .map((entry) => entry.file);
    const requests = sideRefused
      .filter((entry) => defOf(entry).part === "exchange")
      .map((entry) => entry.file);
    expect(answers.length + requests.length).toBe(sideRefused.length);
    expect(Object.keys(RESPONSE_TWINS).sort()).toEqual([...answers].sort());
    expect(Object.keys(REQUEST_TWINS).sort()).toEqual([...requests].sort());
    for (const [file, { twin }] of [...Object.entries(RESPONSE_TWINS), ...Object.entries(REQUEST_TWINS)]) {
      const twinEntry = entryOf(twin);
      expect([twinEntry.expect, defOf(twinEntry).part], `${file}'s twin`).toEqual(["accept", "exchange"]);
      expect(defOf(twinEntry).call, `${file}'s twin's call`).toBe(defOf(entryOf(file)).call);
      expect(
        sideAccepted.map((entry) => entry.file),
        `${file}'s twin runs here`,
      ).toContain(twin);
    }
  });

  it("has a twin for every refused request: an accepted exchange with its given and outcome, and its request but for the fault", () => {
    for (const [file, twin] of Object.entries(REQUEST_TWINS)) {
      const refused = exchangeOf(file);
      const right = exchangeOf(twin.twin);
      expect(refused.call, file).toBe(right.call);
      expect(refused.given, `${file}: its twin's given`).toEqual(right.given);
      expect(refused.outcome, `${file}: its twin's outcome`).toEqual(right.outcome);
      const differ = differences(refused.request, right.request);
      expect(differ.length, `${file}: its request differs`).toBeGreaterThan(0);
      for (const place of differ) {
        expect(
          twin.faults.some((fault) => within(place, fault)),
          `${file}: ${place} is the fault`,
        ).toBe(true);
      }
    }
  });

  it("lists in read-price-rules-haircut-tie's note the two rows its database side writes first, in order and value for value; no other v1.18 note lists a row", () => {
    const note = exchangeOf(TIE_FIXTURE).given.note ?? "";
    const [rulePhrase = "", tiePhrase = ""] = TIE_NOTE_PHRASES;
    expect(note).toContain("the database side writes these two rows itself before the read, in this order");
    expect(note).toContain(rulePhrase);
    expect(note).toContain(tiePhrase);
    expect(note.indexOf(rulePhrase)).toBeLessThan(note.indexOf(tiePhrase));
    expect(tieRows().map((row) => [row.table, row.values.id])).toEqual([
      ["price_rules", EVENING.ruleId],
      ["price_rule_ties", EVENING.tieId],
    ]);
    for (const entry of sideEntries.filter((candidate) => candidate.file !== TIE_FIXTURE)) {
      expect(notedRowsOf(entry.file), entry.file).toEqual([]);
      const value = fixture(entry.file);
      const state = isRecord(value) ? value.given : undefined;
      const other = isRecord(state) && typeof state.note === "string" ? state.note : "";
      expect(other.includes("writes these two rows itself"), entry.file).toBe(false);
    }
  });

  it(
    "finds each K-26 registry row a seed chain names stored as migration 0023 wrote it, and inserts none",
    SLOW,
    async () => {
      const chained = sideAccepted.filter((entry) =>
        worldRowsOf(exchangeOf(entry.file).given).some((row) => REGISTRY_KEYS.has(row.table)),
      );
      expect(chained.length, "a chain that names registry rows").toBeGreaterThan(0);
      await reset();
      const before = await registryCounts();
      expect(
        Object.values(before).every((rows) => rows > 0),
        "the migration's seed",
      ).toBe(true);
      for (const entry of chained) {
        const named = worldRowsOf(exchangeOf(entry.file).given).filter((row) => REGISTRY_KEYS.has(row.table));
        expect(named.length, entry.file).toBeGreaterThan(0);
        await given(entry.file);
        expect(await registryCounts(), `${entry.file}: no registry row inserted`).toEqual(before);
      }
      // A registry row stored otherwise than its seed gives it, or not stored, is a broken world, never inserted.
      const [first] = worldRowsOf(exchangeOf(must(chained[0]).file).given).filter((row) =>
        REGISTRY_KEYS.has(row.table),
      );
      const row = must(first, "a registry row");
      const key = must(REGISTRY_KEYS.get(row.table));
      await expect(
        lookUpRegistryRow(
          db.sql,
          { table: row.table, values: { ...row.values, source: "another source" } },
          key,
        ),
      ).rejects.toThrow("is not stored as the seed gives it");
      await expect(
        lookUpRegistryRow(db.sql, { table: row.table, values: { ...row.values, [key]: "nosuchname" } }, key),
      ).rejects.toThrow("migration 0023's seed does not hold it");
      expect(await registryCounts()).toEqual(before);
    },
  );

  it("runs every read as rosie_app, the Tool API's role", SLOW, async () => {
    const [who] = await app<{ role: string }[]>`select current_user as role`;
    expect(who?.role).toBe(APP_ROLE);
  });
});

describe("data-access v1.18 database side: each accepted exchange gives its outcome through db/repo, from its seeds", () => {
  for (const entry of sideAccepted) {
    it(
      `${entry.file}: as rosie_app, db/repo answers the fixture's outcome, valid at ${entry.version}`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        sent.length = 0;
        const answer = await runExchange(exchange);
        expect(answer).toEqual(exchange.outcome);
        expect(answerErrors(entry.version, exchange.call, answer), "the answer").toEqual([]);
        expect(
          errorsOf(validatorOf(entry.version, must(entry.def)), { ...exchange, outcome: answer }),
          "the exchange with db/repo's answer",
        ).toEqual([]);
        expect(sent.length, "the read reached the database").toBeGreaterThan(0);
      },
    );
  }
});

describe("data-access v1.18 database side: under another business each read answers none of the first business's rows", () => {
  for (const entry of sideAccepted.filter((accepted) => !isError(exchangeOf(accepted.file).outcome))) {
    it(
      `${entry.file}: the same request for every other business of its world answers that business's rows alone`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        const business = exchange.request.businessId;
        if (typeof business !== "string") throw new Error(`${entry.file} names no business`);
        const others = (await businessesOfWorld()).filter((id) => id !== business);
        expect(others.length, "another business in the world").toBeGreaterThan(0);
        const theirs = await runExchange(exchange);
        expect(theirs, "the exchange's own answer").toEqual(exchange.outcome);
        for (const other of others) {
          const answer = await runExchange({
            ...exchange,
            request: { ...exchange.request, businessId: other },
          });
          expect(answerErrors(entry.version, exchange.call, answer), `under ${other}`).toEqual([]);
          expect(isRecord(answer) ? answer.businessId : null, `under ${other}`).toBe(other);
          expect(otherBusinessProblems(answer, other, business, theirs), `under ${other}`).toEqual([]);
        }
      },
    );
  }

  it("has the other-business check fire: a row of the first business, a row its answer gives, a row that names it", () => {
    const theirs = exchangeOf("read-business-services-lee-home-services.json").outcome;
    const barbershop = exchangeOf("read-business-services-barbershop.json").outcome;
    expect(otherBusinessProblems(barbershop, "biz-lees-barbershop", "biz-lee-home-services", theirs)).toEqual(
      [],
    );
    expect(otherBusinessProblems(theirs, "biz-lees-barbershop", "biz-lee-home-services", theirs)).toEqual([
      "svc-lee-electric-wiring-repair is biz-lee-home-services's, not biz-lees-barbershop's",
      "a row names biz-lee-home-services",
    ]);
    const wiring = must((theirs.services as Record<string, Json>[])[0], "Lee's one service");
    const borrowed = { ...barbershop, services: [{ ...wiring, businessId: "biz-lees-barbershop" }] };
    expect(otherBusinessProblems(borrowed, "biz-lees-barbershop", "biz-lee-home-services", theirs)).toEqual([
      "svc-lee-electric-wiring-repair is a row biz-lee-home-services's answer gives",
    ]);
    const kinds = exchangeOf("read-business-kinds-barbershop.json").outcome;
    const setup = { ...(kinds.setup as Record<string, Json>), businessId: "biz-lee-home-services" };
    const setupOfLee = { ...kinds, setup };
    expect(otherBusinessProblems(setupOfLee, "biz-lees-barbershop", "biz-lee-home-services", theirs)).toEqual(
      [
        "biz-lee-home-services is biz-lee-home-services's, not biz-lees-barbershop's",
        "a row names biz-lee-home-services",
      ],
    );
  });
});

describe("data-access v1.18 database side: each refused fixture is refused by db/repo", () => {
  for (const entry of sideRefused.filter((refused) => Object.hasOwn(REQUEST_TWINS, refused.file))) {
    it(
      `${entry.file}: in its own given db/repo refuses its request before any statement reaches the database, and answers it put right as its twin`,
      SLOW,
      async () => {
        const twin = must(REQUEST_TWINS[entry.file], `${entry.file}'s twin`);
        const validate = validatorOf(entry.version, must(entry.def));
        expect(errorsOf(validate, exchangeOf(entry.file)), "refused by its definition").not.toEqual([]);
        // In its own given, where the business and its rows are there to be read: refused as it stands.
        const exchange = await given(entry.file);
        sent.length = 0;
        await expect(runExchange(exchange)).rejects.toThrow(TypeError);
        expect(sent, "no statement was sent: nothing read").toEqual([]);
        // With its one fault taken out the request is its twin's, and db/repo answers it the outcome both state.
        const right: Exchange = { ...exchange, request: exchangeOf(twin.twin).request };
        const answer = await runExchange(right);
        expect(answer, "the twin's outcome, which the refused fixture states too").toEqual(exchange.outcome);
        expect(answerErrors(entry.version, exchange.call, answer), "db/repo's answer").toEqual([]);
        expect(errorsOf(validate, { ...right, outcome: answer }), "put right, with db/repo's answer").toEqual(
          [],
        );
        expect(sent.length, "the request put right reached the database").toBeGreaterThan(0);
      },
    );
  }

  for (const entry of sideRefused.filter((refused) => Object.hasOwn(RESPONSE_TWINS, refused.file))) {
    it(
      `${entry.file}: in its twin's state db/repo answers it put right, never as it stands`,
      SLOW,
      async () => {
        const twin = must(RESPONSE_TWINS[entry.file], `${entry.file}'s twin`);
        const validate = validatorOf(entry.version, must(entry.def));
        const refused = fixture(entry.file);
        expect(errorsOf(validate, refused), "refused by its definition").not.toEqual([]);
        const exchange = await given(twin.twin);
        const answer = await runExchange(exchange);
        expect(answer, "the twin's own outcome").toEqual(exchange.outcome);
        expect(errorsOf(validate, answer), "db/repo's answer, by the refused fixture's definition").toEqual(
          [],
        );
        expect(twinProblems(refused, answer, twin)).toEqual([]);
      },
    );
  }

  it("has the twin check fire: an answer as the refused one stands, a difference beside the fault, a fault not there", () => {
    const refused = fixture("invalid/refuse-service-ways-cutoff-as-interval.json");
    const right = exchangeOf("read-service-ways-skin-fade.json").outcome;
    const faults = ["ways.0.cutoffBeforeMinutes"];
    expect(twinProblems(refused, right, { faults })).toEqual([]);
    expect(twinProblems(refused, refused, { faults })).toEqual([
      "db/repo answers the refused fixture as it stands",
      "the fault ways.0.cutoffBeforeMinutes is not where db/repo's answer differs",
    ]);
    expect(twinProblems(refused, { ...right, readAt: "2026-10-26T14:00:01Z" }, { faults })).toEqual([
      "db/repo's answer differs at readAt, which is not the fault",
    ]);
    expect(twinProblems(refused, right, { faults: [...faults, "ways.0.feeCents"] })).toEqual([
      "the fault ways.0.feeCents is not where db/repo's answer differs",
    ]);
  });
});
