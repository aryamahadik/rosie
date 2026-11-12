// Contract test for K-04, the database schema's core part: its database side for v1.1 (T-1290; ops/plan/02-contracts.md
// K-04 "Contract test"; contracts/db-schema/core/README.md section "v1.1", its table "Refused rows (v1.1)" and its line
// "the catalog, the migration and the twins on PostgreSQL are M1's and T-1290's to prove"; contracts/README.md
// convention 5: a seed row's part's contract test checks it against a migrated database; ADR-016 section 1).
//
// db-schema.core.v1.test.ts checks every fixture of fixtures/index.json against a model of its version's table list.
// This part checks the entries of the versions in DB_SIDE against PostgreSQL with every migration of db/migrations
// applied to a fresh schema (db/repo/test-db.ts), among them T-1278's 0032 and 0033, which make the two outbox tables
// v1.1's. Every entry whose version has a database side here runs, selected by its version, never by a pinned list or
// count (DL-124, DL-125):
//   - an accepted fixture loads with its `after` chain, and its table gets rows (v1.1 holds none: README default 13);
//   - a refused fixture: its `after` chain and its rows load, and its one action, run as its side, is refused with the
//     SQLSTATE and one of the constraints its `expect` names (or returns its rows); put right as the README puts it
//     (db-schema.core.twins.ts, from which the model puts it right too), the same action passes and writes one row.
// The rows load as the tables' owner, as the database engineer's seeds do. The action runs as README rule 4's side:
// the runtime side as rosie_job with no business scope, a Tool API call as rosie_app under its business (0012's roles
// and policies). Each fixture runs in one transaction that is always rolled back, and each action in a savepoint rolled
// back after it, so nothing is ever committed and every fixture starts from the empty migrated schema.
//
// Not here: the rest of the producer's side (SIDE_CHECKS' producer-database in db-schema.core.v1.test.ts: v1's catalog,
// seeds and refused rows on PostgreSQL) stays its own QA side task, and db/repo/outbox-schema.int.test.ts (T-1278)
// compares the two outbox tables' catalog with core.v1.1.tables.json.
//
// It needs PostgreSQL: `npm run db:up` locally (DATABASE_URL, else the local Docker database when CI is unset), and the
// merge check's service database (DATABASE_URL) in CI.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { CONTRACTS_ROOT, type FixtureEntry } from "./_harness";
import { PUT_RIGHT_V1_1, putRight, type FixtureValue, type PutRight } from "./db-schema.core.twins";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const FIXTURES_DIR = path.join(CONTRACTS_ROOT, "db-schema", "core", "fixtures");
const SLOW = { timeout: 60_000 };

/**
 * The versions with a database side here, each with the ways its refused fixtures are put right: v1.1 (T-1290). v1's
 * is SIDE_CHECKS' producer side, a QA side task of its own.
 */
const DB_SIDE: Readonly<Record<string, Readonly<Record<string, PutRight>>>> = { "v1.1": PUT_RIGHT_V1_1 };
const DB_SIDE_VERSIONS = Object.keys(DB_SIDE);

type Json = FixtureValue | Json[] | { [key: string]: Json };

/** What a refused action must meet (README "Seed and refused-row fixtures"). */
interface Expect {
  sqlstate?: string;
  constraintOneOf?: string[];
  rows?: number;
}

/** A refused fixture's one action, run as `role` under `scope`. */
interface Action {
  role: "runtime" | "toolApi";
  scope: { businessId: string } | null;
  action: "insert" | "update" | "select";
  table: string;
  values?: Record<string, Json>;
  set?: Record<string, Json>;
  where?: Record<string, Json>;
  expect: Expect;
}

/** A fixture file (README "Seed and refused-row fixtures"): rows loaded after the fixtures `after` names. */
interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
  refused?: Action;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

const entries = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] }).fixtures;
/** Every entry of a version with a database side, in the index's order. */
const sideEntries = entries.filter((entry) => DB_SIDE_VERSIONS.includes(entry.version));
const sideRefused = sideEntries.filter((entry) => entry.expect === "refuse");

/** A fresh copy of a fixture of the index, named as the index and `after` name it. */
const fixtureOf = (file: string): FixtureFile =>
  readJson(path.join(FIXTURES_DIR, ...file.split("/"))) as FixtureFile;

/** The way a refused entry is put right, from its version's list. */
const putRightOf = (entry: FixtureEntry): PutRight | undefined => DB_SIDE[entry.version]?.[entry.file];

// ---------------------------------------------------------------------------------------------------------------
// The database: one fresh schema for this file, in a database of its own, every statement inside a transaction that is
// rolled back

let db: TestDatabase;
/** The jsonb and bytea columns of the migrated schema, `<table>.<column>`, with their types. */
let typedColumns: Map<string, string>;

beforeAll(async () => {
  db = await createTestDatabase({ name: "core_db_side", client: { max: 1 }, database: "own" });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 120_000);

afterAll(async () => {
  await db.drop();
});

/** The bytes a bytea's hex names, two digits a byte. */
const bytesOfHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/[0-9a-fA-F]{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));

/** A fixture value as PostgreSQL takes it (README: jsonb as JSON, bytea as \x and hex, the rest as text input). */
function valueOf(sql: Tx, table: string, column: string, value: Json): unknown {
  if (value === null) return null;
  const type = typedColumns.get(`${table}.${column}`);
  if (type === "jsonb") return sql.json(value);
  if (type === "bytea" && typeof value === "string") return bytesOfHex(value.replace(/^\\x/, ""));
  return value;
}

/** A fixture's column values as one row of parameters. */
function rowOf(sql: Tx, table: string, values: Record<string, Json>): Record<string, never> {
  const row: Record<string, never> = {};
  for (const [column, value] of Object.entries(values))
    row[column] = valueOf(sql, table, column, value) as never;
  return row;
}

/** `<column> = <value> and ...`: the rows a fixture's `where` names. */
function whereOf(sql: Tx, table: string, where: Record<string, Json>) {
  const conditions = Object.entries(where).map(
    ([column, value]) => sql`${sql(column)} = ${valueOf(sql, table, column, value) as never}`,
  );
  if (conditions.length === 0) throw new Error(`a where on ${table} that names no column`);
  return conditions.reduce((all, condition) => sql`${all} and ${condition}`);
}

/** Loads a fixture after the fixtures its `after` names (each once, in order), its rows as the tables' owner. */
async function load(tx: Tx, file: string, loaded: Set<string>, chain: readonly string[] = []): Promise<void> {
  if (loaded.has(file)) return;
  if (chain.includes(file)) throw new Error(`the after chain loops: ${[...chain, file].join(" -> ")}`);
  const content = fixtureOf(file);
  for (const first of content.after) await load(tx, first, loaded, [...chain, file]);
  for (const row of content.rows) {
    await tx`insert into ${tx(row.table)} ${tx(rowOf(tx, row.table, row.values))}`;
  }
  loaded.add(file);
}

/** Runs an action's one statement: the rows it wrote or read. */
async function statementOf(sql: Tx, action: Action): Promise<number> {
  const { table } = action;
  if (action.action === "insert") {
    const result =
      await sql`insert into ${sql(table)} ${sql(rowOf(sql, table, must(action.values, "values")))}`;
    return result.count;
  }
  if (action.action === "update") {
    const set = rowOf(sql, table, must(action.set, "set"));
    const result = await sql`
      update ${sql(table)} set ${sql(set)} where ${whereOf(sql, table, must(action.where, "where"))}
    `;
    return result.count;
  }
  const rows =
    await sql`select * from ${sql(table)} where ${whereOf(sql, table, must(action.where, "where"))}`;
  return rows.length;
}

/** What an action did: the rows it wrote or read, or PostgreSQL's refusal (its SQLSTATE and the constraint it names). */
type Outcome =
  | { rows: number; refusal: null }
  | { rows: null; refusal: { sqlstate: string; constraint: string | null; message: string } };

/** Thrown to roll a savepoint back once its action has passed, carrying the rows the action wrote or read. */
class Undone extends Error {
  constructor(readonly rows: number) {
    super("the action's savepoint is rolled back");
  }
}

/** Thrown to roll a fixture's transaction back once its checks have run, carrying what they found. */
class RolledBack<T> extends Error {
  constructor(readonly found: T) {
    super("the fixture's transaction is rolled back");
  }
}

/** Runs `fn` in one transaction that is always rolled back: nothing a fixture loads or an action writes is kept. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await db.sql.begin(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.found as T;
    throw error;
  }
  throw new Error("a fixture's transaction ended without being rolled back");
}

/**
 * Runs a refused fixture's action as its side (README rule 4): the runtime side as rosie_job with no business scope, a
 * Tool API call as rosie_app under its business. It runs in a savepoint rolled back after it, so it leaves nothing:
 * no row, no role, no scope. A failure that is not PostgreSQL's refusal is a broken test.
 */
async function attempt(tx: Tx, action: Action): Promise<Outcome> {
  try {
    await tx.savepoint(async (sql) => {
      if (action.role === "runtime") {
        await sql`set local role rosie_job`;
      } else {
        const { businessId } = must(action.scope, "a Tool API call's business scope");
        await sql`set local role rosie_app`;
        await sql`select set_config('rosie.business_id', ${businessId}, true)`;
      }
      throw new Undone(await statementOf(sql, action));
    });
  } catch (error) {
    if (error instanceof Undone) return { rows: error.rows, refusal: null };
    const failure = error as { code?: unknown; constraint_name?: unknown; message?: unknown };
    if (typeof failure.code !== "string" || !/^[0-9A-Z]{5}$/.test(failure.code)) throw error;
    return {
      rows: null,
      refusal: {
        sqlstate: failure.code,
        constraint: typeof failure.constraint_name === "string" ? failure.constraint_name : null,
        message: typeof failure.message === "string" ? failure.message : "",
      },
    };
  }
  throw new Error("an action's savepoint ended without being rolled back");
}

/** One line per way an outcome misses what a refused fixture expects; none when it meets it. */
function expectProblems(outcome: Outcome, wanted: Expect): string[] {
  if (wanted.sqlstate !== undefined) {
    if (outcome.refusal === null) return [`must be refused with ${wanted.sqlstate}, but passes`];
    const { sqlstate, constraint, message } = outcome.refusal;
    const problems: string[] = [];
    if (sqlstate !== wanted.sqlstate)
      problems.push(`must be refused with ${wanted.sqlstate}, but is refused with ${sqlstate} ${message}`);
    if (wanted.constraintOneOf !== undefined && !wanted.constraintOneOf.includes(constraint ?? ""))
      problems.push(
        `must be refused by one of ${wanted.constraintOneOf.join(", ")}, but by ${constraint ?? "no constraint"}`,
      );
    return problems;
  }
  if (outcome.refusal !== null)
    return [`must return ${String(wanted.rows)} rows, but is refused: ${outcome.refusal.message}`];
  return outcome.rows === wanted.rows
    ? []
    : [`must return ${String(wanted.rows)} rows, but returns ${String(outcome.rows)}`];
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

describe("db-schema core database side: the fixtures of v1.1 against PostgreSQL with every migration applied (0032 and 0033 among them)", () => {
  it("runs every entry of a version with a database side, selected by its version, each refused one with its way to be put right and no other", () => {
    expect(sideEntries.length).toBeGreaterThan(0);
    for (const version of DB_SIDE_VERSIONS)
      expect(sideEntries.filter((entry) => entry.version === version).length, version).toBeGreaterThan(0);
    const ways = Object.entries(DB_SIDE).flatMap(([version, files]) =>
      Object.keys(files).map((file) => `${version} ${file}`),
    );
    expect([...ways].sort()).toEqual(sideRefused.map((entry) => `${entry.version} ${entry.file}`).sort());
  });

  for (const entry of sideEntries) {
    if (entry.expect === "accept") {
      it(
        `loads ${entry.file} (${entry.version}) with its after chain, and ${entry.table ?? "(no table)"} gets rows`,
        SLOW,
        async () => {
          const table = must(entry.table, `${entry.file}'s table`);
          const count = await rolledBack(async (tx) => {
            await load(tx, entry.file, new Set());
            const [row] = await tx<{ count: number }[]>`select count(*)::int as count from ${tx(table)}`;
            return row?.count ?? 0;
          });
          expect(count).toBeGreaterThan(0);
        },
      );
    } else {
      const fix = putRightOf(entry);
      it(
        `refuses ${entry.file} (${entry.version}) because ${fix?.reason ?? "(no way to put it right)"}; put right (${fix?.putRight ?? ""}), the same action passes and writes one row`,
        SLOW,
        async () => {
          const content = fixtureOf(entry.file);
          const action = must(content.refused, "the refused action");
          expect(action.table, "the table its entry names").toBe(entry.table);
          const right = putRight(action, must(fix, `a way to put right ${entry.file}`));
          const [refused, passed] = await rolledBack(async (tx) => {
            await load(tx, entry.file, new Set());
            return [await attempt(tx, action), await attempt(tx, right)] as const;
          });
          expect(expectProblems(refused, action.expect)).toEqual([]);
          expect(passed).toEqual({ rows: 1, refusal: null });
        },
      );
    }
  }

  it(
    "runs each side as its role, keeps nothing, and its check fires: a Tool API call cannot read handles, the runtime side can; the role and scope end with the savepoint; no row outlives the transaction",
    SLOW,
    async () => {
      const read = (role: Action["role"]): Action => ({
        role,
        scope: role === "toolApi" ? { businessId: "biz-lees-barbershop" } : null,
        action: "select",
        table: "handles",
        where: { id: "handle-sam" },
        expect: { rows: 1 },
      });
      const [asToolApi, asRuntime, after] = await rolledBack(async (tx) => {
        await load(tx, "seed-person-roles.json", new Set());
        const outcomes = [await attempt(tx, read("toolApi")), await attempt(tx, read("runtime"))] as const;
        const [state] = await tx<{ owner: boolean; scope: string | null }[]>`
          select current_user = session_user as owner, current_setting('rosie.business_id', true) as scope
        `;
        return [...outcomes, state] as const;
      });
      // 0012: rosie_app holds no grant on handles, which span businesses; rosie_job reads them.
      expect(asToolApi.refusal?.sqlstate).toBe("42501");
      expect(asRuntime).toEqual({ rows: 1, refusal: null });
      expect(after?.owner, "the role ends with its savepoint").toBe(true);
      expect(after?.scope ?? "", "the scope ends with its savepoint").toBe("");
      const [kept] = await db.sql<{ count: number }[]>`select count(*)::int as count from handles`;
      expect(kept?.count, "nothing is committed").toBe(0);
      // The check fires on an outcome that misses its fixture: one that passes, or is refused by another constraint.
      expect(expectProblems(asRuntime, { sqlstate: "23514" })).toEqual([
        "must be refused with 23514, but passes",
      ]);
      expect(
        expectProblems(
          { rows: null, refusal: { sqlstate: "23514", constraint: "outbox_rows_turn_or_job", message: "" } },
          { sqlstate: "23514", constraintOneOf: ["outbox_rows_code_has_not_after"] },
        ),
      ).toEqual(["must be refused by one of outbox_rows_code_has_not_after, but by outbox_rows_turn_or_job"]);
      expect(expectProblems(asToolApi, { rows: 1 })[0]).toMatch(/^must return 1 rows, but is refused/);
    },
  );
});
