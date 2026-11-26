// Contract test for K-23 v1.1, the database schema's business setup part: the sign-up's claim per business (T-1571;
// ruling T-1543 card B12, ops/reviews/signup-remainder/rule-rest.json; contracts/db-schema/business-setup/README.md
// lines 13 and 15, section "v1.1" with rule 8 (line 105), the consumer table's QA row (line 133), the seed row of
// default 9 (line 146), and defaults 8 to 18). README line 15 names this file.
//
// What it proves:
//   a. The files, with no database: the index's v1.1 entries, selected by their version and never by a pinned list or
//      count (DL-124, DL-125), are refused business_setup rows, each naming one reason and with one way to be put right
//      that changes nothing else; business-setup.v1.1.tables.json restates v1's other eight tables exactly and
//      business_setup's v1 columns, keys and checks first (default 8).
//   b. The catalog of business_setup against v1.1's list as migration 0040 makes it: the two columns after version,
//      nullable with no default; business_setup_claimed_by_fk; the two CHECKs, validated, equal to the list's expressions
//      as pg_get_constraintdef prints both (the list's put on a temporary probe table); rule 8's trigger, BEFORE UPDATE
//      FOR EACH ROW, firing before business_setup_version_raised (name order, and shown by an update that changes the
//      claim without raising version); its function's body equal to `begin <README rule 8's body> end;`, the body read
//      from the README. No migration name, list or count is pinned (later migrations may land beside 0040).
//   c. The seed row (default 9: refuse-signup-claim-second-write's rows) loads with its after chain and stores every
//      value as given.
//   d. Each refused fixture refused as its expect says, acting as its role and scope; of the table's CHECKs and rule 8 its
//      row breaks the one it names and no other; put right as the README's table puts it, the same action passes.
//   e. Edges (DL-618): signup_claim's words; the claim and its person both or neither; rule 8 for both application
//      roles: a change, a clear and a person swap refused, the same values and another column's update pass, and a null
//      claim set once.
// Not here: K-23 v1's own contract test (db-schema.business-setup.v1.test.ts, QA's own task) and v1's entries
// (db/repo/business-setup.int.test.ts, T-1553).
//
// It needs PostgreSQL (the local Docker database when CI is unset, the merge check's service database in CI). Its
// schema is made in a pool database of its own (createTestDatabase with database "own"), every migration of
// db/migrations applied. Every fixture runs in one transaction that is always rolled back and every action in a
// savepoint, so nothing is committed. Rows come only from the fixtures (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { CONTRACTS_ROOT, checkContractFixtures, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const PART = "business-setup";
const PART_DIR = path.join(CONTRACTS_ROOT, "db-schema", PART);
const FIXTURES_DIR = path.join(PART_DIR, "fixtures");
const VERSION = "v1.1";
/** The one table v1.1 changes (README section "v1.1"). */
const TABLE = "business_setup";
/** Rule 8's trigger and the constraint name its refusal carries (README line 105). */
const SET_ONCE = "business_setup_claim_set_once";
/** 0019's version trigger on the table (K-04 v1 rule 2). */
const VERSION_RAISED = "business_setup_version_raised";
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

/** A call's settings (README rule 5; K-04's fixture format): rosie.business_id; left out, unset. */
interface Scope {
  businessId?: string;
}
interface Expect {
  sqlstate?: string;
  constraintOneOf?: string[];
  rows?: number;
}
/** A refused fixture's one action, run as `role` with `scope`'s settings. */
interface Action {
  role: "runtime" | "toolApi";
  scope: Scope | null;
  action: "insert" | "update";
  table: string;
  values?: Values;
  set?: Values;
  where?: Values;
  expect: Expect;
}
interface FixtureRow {
  table: string;
  values: Values;
}
interface FixtureFile {
  after: string[];
  rows: FixtureRow[];
  refused?: Action;
}
interface Column {
  name: string;
  type: string;
  null: boolean;
  default?: string;
}
interface Table {
  name: string;
  description: string;
  source: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys?: {
    name: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete?: string;
  }[];
  checks?: { name: string; expression: string }[];
  [key: string]: unknown;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

const sorted = (items: readonly string[]): string[] => [...items].sort();

const entries = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] }).fixtures;
/** v1.1's entries, in the index's order. */
const versionEntries = entries.filter((entry) => entry.version === VERSION);
const versionRefused = versionEntries.filter((entry) => entry.expect === "refuse");

const listOf = (version: string): { version: string; tables: Table[] } =>
  readJson(path.join(PART_DIR, `${PART}.${version}.tables.json`)) as { version: string; tables: Table[] };
const v1List = listOf("v1");
const versionList = listOf(VERSION);
const tableOf = (list: { tables: Table[] }, name: string): Table =>
  must(
    list.tables.find((table) => table.name === name),
    `${name} in a table list`,
  );
const setupTable = tableOf(versionList, TABLE);
const listedChecks = setupTable.checks ?? [];

/** README rule 8's body, as the README gives it (line 105), read from the file. */
const README = readFileSync(path.join(PART_DIR, "README.md"), "utf8");
const RULE_8_BODY = /Its body, in K-30's form: `([^`]+)`/u.exec(README)?.[1];

const fixturePath = (file: string): string => path.join(FIXTURES_DIR, ...file.split("/"));
const fixtureAt = (absolute: string): FixtureFile => readJson(absolute) as FixtureFile;
const fixtureOf = (file: string): FixtureFile => fixtureAt(fixturePath(file));
const refusedActionOf = (file: string): Action => must(fixtureOf(file).refused, `${file}'s refused action`);

/** The fixtures/ folder of a fixture file: a refused fixture sits in fixtures/invalid/. */
function fixturesFolderOf(absolute: string): string {
  const folder = path.dirname(absolute);
  return path.basename(folder) === "invalid" ? path.dirname(folder) : folder;
}

/**
 * The files a fixture loads, each once, its `after` chain first, in load order. Each `after` path is relative to the
 * fixtures/ folder of the file that names it, so K-23's seeds name K-04's as ../../core/fixtures/<file>.
 */
function chainFiles(absolute: string, loaded: string[] = [], chain: readonly string[] = []): string[] {
  if (loaded.includes(absolute)) return loaded;
  if (chain.includes(absolute))
    throw new Error(`the after chain loops: ${[...chain, absolute].join(" -> ")}`);
  const folder = fixturesFolderOf(absolute);
  for (const first of fixtureAt(absolute).after)
    chainFiles(path.resolve(folder, ...first.split("/")), loaded, [...chain, absolute]);
  loaded.push(absolute);
  return loaded;
}

/** A fixture's rows after those of its chain; `own` stands in for the fixture's own rows (a twin's). */
function chainRows(file: string, own?: readonly FixtureRow[]): FixtureRow[] {
  const absolute = fixturePath(file);
  return chainFiles(absolute).flatMap((each) =>
    each === absolute && own !== undefined ? [...own] : fixtureAt(each).rows,
  );
}

/** The rows of `table` among a fixture's own rows. */
const ownRowsOf = (file: string, table: string): Values[] =>
  fixtureOf(file)
    .rows.filter((row) => row.table === table)
    .map((row) => row.values);

/** The v1.1 refused entry whose `expect` names `constraint`. */
const refusedByConstraint = (constraint: string): FixtureEntry =>
  must(
    versionRefused.find((entry) =>
      (refusedActionOf(entry.file).expect.constraintOneOf ?? []).includes(constraint),
    ),
    `a refused v1.1 fixture of ${constraint}`,
  );

/** The seed row of v1.1 (default 9): the refused entry whose own rows hold a business_setup row. */
const seedEntry = must(
  versionRefused.find((entry) => ownRowsOf(entry.file, TABLE).length > 0),
  "a v1.1 entry whose rows hold the seed row",
);
const seedRow = must(ownRowsOf(seedEntry.file, TABLE)[0], "the seed row");
/** A full setup row as S1-09's writer inserts it, from the insert of the refused fixture of the claim's word. */
const insertedRow = must(
  refusedActionOf(refusedByConstraint("business_setup_signup_claim_known").file).values,
  "the insert's values",
);
const businessId = (values: Values): string => {
  const id = values.business_id;
  if (typeof id !== "string") throw new Error("a setup row names its business");
  return id;
};

// ---------------------------------------------------------------------------------------------------------------
// Each refused v1.1 fixture's one way to be put right (README section "v1.1", the refused rows' table)

/** A fixture as it runs: its own rows (after its chain) and its one action. */
interface Run {
  rows: FixtureRow[];
  action: Action;
}

interface PutRight {
  /** How the README's table puts it right. */
  putRight: string;
  /** The parts the twin changes, and no other: rows.<table>.<column>, values.<column>, set.<column>, role, scope... */
  changes: readonly string[];
  mend: (run: Run) => Run;
}

const withValue = (run: Run, column: string, value: Json): Run => ({
  ...run,
  action: { ...run.action, values: { ...must(run.action.values, "an insert's values"), [column]: value } },
});

const PUT_RIGHT: Readonly<Record<string, PutRight>> = {
  "invalid/refuse-signup-claim-unknown-word.json": {
    putRight: "the claim owner",
    changes: ["values.signup_claim"],
    mend: (run) => withValue(run, "signup_claim", "owner"),
  },
  "invalid/refuse-signup-claim-without-person.json": {
    putRight: "claimed_by_person_id person-sam",
    changes: ["values.claimed_by_person_id"],
    mend: (run) => withValue(run, "claimed_by_person_id", "person-sam"),
  },
  "invalid/refuse-signup-claim-second-write.json": {
    putRight: "the same update on the row with no claim on file, which sets it once",
    changes: ["rows.business_setup.claimed_by_person_id", "rows.business_setup.signup_claim"],
    mend: (run) => ({
      ...run,
      rows: run.rows.map((row) =>
        row.table === TABLE
          ? { ...row, values: { ...row.values, signup_claim: null, claimed_by_person_id: null } }
          : row,
      ),
    }),
  },
};

const runOf = (file: string): Run => ({ rows: fixtureOf(file).rows, action: refusedActionOf(file) });
const putRightOf = (entry: FixtureEntry): PutRight =>
  must(PUT_RIGHT[entry.file], `a way to put ${entry.file} right`);
const twinOf = (entry: FixtureEntry): Run => putRightOf(entry).mend(runOf(entry.file));

/** The parts in which two runs differ. */
function differences(a: Run, b: Run): string[] {
  const out: string[] = [];
  const columns = (left: Values, right: Values): string[] =>
    [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
      (column) => !isDeepStrictEqual(left[column], right[column]),
    );
  if (a.rows.length !== b.rows.length) out.push("rows");
  a.rows.forEach((row, n) => {
    const other = b.rows[n];
    if (other?.table !== row.table) out.push(`rows.${String(n)}`);
    else for (const column of columns(row.values, other.values)) out.push(`rows.${row.table}.${column}`);
  });
  const keys = new Set([...Object.keys(a.action), ...Object.keys(b.action)]) as Set<keyof Action>;
  for (const key of keys) {
    if (key === "values" || key === "set" || key === "where") {
      for (const column of columns(a.action[key] ?? {}, b.action[key] ?? {})) out.push(`${key}.${column}`);
    } else if (!isDeepStrictEqual(a.action[key], b.action[key])) {
      out.push(key);
    }
  }
  return sorted(out);
}

// ---------------------------------------------------------------------------------------------------------------
// The database: one fresh schema with every migration, in a database of this file's own, every statement inside a
// transaction that is rolled back

let db: TestDatabase;
/** `<schema>.business_setup`, for the catalog's reads. */
let qualified = "";
/** The CHECKs of the migrated business_setup, with PostgreSQL's own expression of each. */
let migratedChecks: { name: string; expression: string }[] = [];

/** What an action did: the rows it wrote or changed, or PostgreSQL's refusal (its SQLSTATE and constraint). */
type Outcome =
  | { rows: number; refusal: null }
  | { rows: null; refusal: { sqlstate: string; constraint: string | null; message: string } };

/** Thrown to roll a transaction or savepoint back once its checks have run, carrying what they found. */
class RolledBack extends Error {
  readonly found: unknown;
  constructor(found: unknown) {
    super("rolled back on purpose");
    this.found = found;
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
  throw new Error("a transaction ended without being rolled back");
}

/** PostgreSQL's refusal of a statement, or a broken test when the failure is anything else. */
function refusalOf(error: unknown): { sqlstate: string; constraint: string | null; message: string } {
  const failure = error as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (typeof failure.code !== "string" || !/^[0-9A-Z]{5}$/.test(failure.code)) throw error;
  return {
    sqlstate: failure.code,
    constraint: typeof failure.constraint_name === "string" ? failure.constraint_name : null,
    message: typeof failure.message === "string" ? failure.message : "",
  };
}

const asParameters = (values: Values): Record<string, never> => values as Record<string, never>;

/** `column = value and ...` for each column of `where`. */
function whereOf(sql: Tx, where: Values) {
  const conditions = Object.entries(where).map(([column, value]) => sql`${sql(column)} = ${value as never}`);
  if (conditions.length === 0) throw new Error("a where that names no column");
  return conditions.reduce((all, one) => sql`${all} and ${one}`);
}

/** Runs an action's one statement: the rows it wrote or changed. */
async function statementOf(sql: Tx, action: Pick<Action, "action" | "table" | "values" | "set" | "where">) {
  if (action.action === "insert") {
    const result = await sql`
      insert into ${sql(action.table)} ${sql(asParameters(must(action.values, "an insert's values")))}
    `;
    return result.count;
  }
  const result = await sql`
    update ${sql(action.table)} set ${sql(asParameters(must(action.set, "an update's set")))}
    where ${whereOf(sql, must(action.where, "an update's where"))}
  `;
  return result.count;
}

/** Loads rows in order as the runtime side with no setting (K-04's fixture format), the role ending with the load. */
async function load(tx: Tx, rows: readonly FixtureRow[]): Promise<void> {
  await tx`set local role rosie_job`;
  for (const row of rows) await tx`insert into ${tx(row.table)} ${tx(asParameters(row.values))}`;
  await tx`reset role`;
}

/** The side an action runs as (README rule 5 and default 18): the Tool API as rosie_app, the runtime as rosie_job. */
interface Side {
  role: Action["role"];
  scope: Scope | null;
}
type Statement = Pick<Action, "action" | "table" | "values" | "set" | "where">;

/**
 * Runs statements in order as one side, each in a savepoint of its own: one that passes is kept for the next, one
 * that is refused is rolled back. An outer savepoint rolled back after them leaves nothing: no row, role or setting.
 */
async function inOrder(tx: Tx, side: Side, statements: readonly Statement[]): Promise<Outcome[]> {
  try {
    await tx.savepoint(async (outer) => {
      if (side.role === "runtime") await outer`set local role rosie_job`;
      else await outer`set local role rosie_app`;
      if (side.scope?.businessId !== undefined)
        await outer`select set_config('rosie.business_id', ${side.scope.businessId}, true)`;
      const outcomes: Outcome[] = [];
      for (const statement of statements) {
        try {
          const rows = await outer.savepoint((inner) => statementOf(inner, statement));
          outcomes.push({ rows, refusal: null });
        } catch (error) {
          outcomes.push({ rows: null, refusal: refusalOf(error) });
        }
      }
      throw new RolledBack(outcomes);
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.found as Outcome[];
    throw error;
  }
  throw new Error("an outer savepoint ended without being rolled back");
}

async function attempt(tx: Tx, action: Action): Promise<Outcome> {
  return must((await inOrder(tx, action, [action]))[0], "the action's outcome");
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
    return [`must touch ${String(wanted.rows)} rows, but is refused: ${outcome.refusal.message}`];
  return outcome.rows === wanted.rows
    ? []
    : [`must touch ${String(wanted.rows)} rows, but touches ${String(outcome.rows)}`];
}

/** A passing outcome of one row, and a refusal by `constraint` with 23514, as expectProblems reads them. */
const PASSES_ONE: Expect = { rows: 1 };
const refusedBy = (constraint: string): Expect => ({ sqlstate: "23514", constraintOneOf: [constraint] });

/**
 * The CHECKs of the migrated business_setup a row breaks (its expression false): the row goes into a temporary copy of
 * the table with its columns and defaults but no constraint, and each CHECK's own expression, as PostgreSQL holds it, is
 * read against it. A savepoint rolled back after it drops the copy.
 */
async function brokenChecks(tx: Tx, values: Values): Promise<string[]> {
  try {
    await tx.savepoint(async (sql) => {
      await sql`create temporary table check_probe (like ${sql(TABLE)} including defaults)`;
      await sql`insert into check_probe ${sql(asParameters(values))}`;
      const columns = migratedChecks.map((check, n) => `(${check.expression}) as c${String(n)}`).join(", ");
      const [row] = await sql.unsafe<Record<string, boolean | null>[]>(`select ${columns} from check_probe`);
      const found = must(row, "the probe row");
      throw new RolledBack(
        migratedChecks.filter((_, n) => found[`c${String(n)}`] === false).map((check) => check.name),
      );
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.found as string[];
    throw error;
  }
  throw new Error("the probe's savepoint ended without being rolled back");
}

/** The row an update leaves: the row on file with the update's set laid over it. */
function afterUpdate(rows: readonly FixtureRow[], action: Action): Values {
  const where = must(action.where, "an update's where");
  const row = must(
    rows.find(
      (each) =>
        each.table === action.table &&
        Object.entries(where).every(([column, value]) => isDeepStrictEqual(each.values[column], value)),
    ),
    "the row the update names",
  );
  return { ...row.values, ...must(action.set, "an update's set") };
}

// ---------------------------------------------------------------------------------------------------------------
// a. The files

describe("K-23 v1.1 fixtures and table list, read from the files (README section v1.1, default 8)", () => {
  it("has an index that lists every fixture file and only those, each entry a seed or refused row", () => {
    const report = checkContractFixtures(path.join("db-schema", PART));
    expect(report.problems).toEqual([]);
    expect(report.entries.filter((entry) => !entry.ok).map((entry) => entry.problems)).toEqual([]);
    expect(report.seedRows).toBe(entries.length);
  });

  it("selects v1.1's entries by their version: refused business_setup rows only (no accepted entry, default 9), each with one way to be put right", () => {
    expect(versionRefused.length).toBeGreaterThan(0);
    expect(versionEntries.filter((entry) => entry.expect !== "refuse")).toEqual([]);
    for (const entry of versionEntries) expect(entry.table, entry.file).toBe(TABLE);
    expect(sorted(Object.keys(PUT_RIGHT))).toEqual(sorted(versionRefused.map((entry) => entry.file)));
    expect(versionList.version).toBe(VERSION);
  });

  for (const entry of versionRefused) {
    it(`${entry.file}: refused for one reason, the one its entry shows; put right (${PUT_RIGHT[entry.file]?.putRight ?? "no way given"}), it changes nothing else`, () => {
      const action = refusedActionOf(entry.file);
      expect(action.table).toBe(TABLE);
      expect([action.role, action.scope]).toEqual(["toolApi", { businessId: businessId(insertedRow) }]);
      expect(action.expect.sqlstate).toBe("23514");
      const [constraint, ...others] = must(action.expect.constraintOneOf, "the one constraint it names");
      expect(others).toEqual([]);
      expect([...listedChecks.map((check) => check.name), SET_ONCE]).toContain(constraint);
      expect(entry.shows).toContain(must(constraint));
      expect(entry.shows).toContain("SQLSTATE 23514");
      expect(differences(runOf(entry.file), twinOf(entry))).toEqual(sorted(putRightOf(entry).changes));
    });
  }

  it("the twin check fires on a damaged twin: a second change is listed", () => {
    const entry = refusedByConstraint("business_setup_claim_with_person");
    const twin = twinOf(entry);
    const damaged: Run = { ...twin, action: { ...twin.action, role: "runtime", scope: {} } };
    expect(differences(runOf(entry.file), damaged)).toEqual(["role", "scope", "values.claimed_by_person_id"]);
  });

  it("the seed row (default 9) is Lee Home Services' setup row with Sam's owner claim, version 1, every other column at its default or null", () => {
    expect(seedEntry).toBe(refusedByConstraint(SET_ONCE));
    expect([seedRow.signup_claim, seedRow.claimed_by_person_id, seedRow.version]).toEqual([
      "owner",
      "person-sam",
      1,
    ]);
    // The same row the inserts write, with the claim kept.
    expect({ ...seedRow, signup_claim: null, claimed_by_person_id: null }).toEqual({
      ...insertedRow,
      signup_claim: null,
      claimed_by_person_id: null,
    });
  });

  it("v1.1's list restates v1's other eight tables exactly, and business_setup's v1 columns, keys and checks first", () => {
    expect(versionList.tables.map((table) => table.name)).toEqual(v1List.tables.map((table) => table.name));
    for (const table of v1List.tables.filter((each) => each.name !== TABLE))
      expect(tableOf(versionList, table.name), table.name).toEqual(table);
    const v1Setup = tableOf(v1List, TABLE);
    const prefix = <T>(list: readonly T[] | undefined, length: number): T[] => (list ?? []).slice(0, length);
    expect(prefix(setupTable.columns, v1Setup.columns.length)).toEqual(v1Setup.columns);
    expect(prefix(setupTable.foreignKeys, (v1Setup.foreignKeys ?? []).length)).toEqual(
      v1Setup.foreignKeys ?? [],
    );
    expect(prefix(setupTable.checks, (v1Setup.checks ?? []).length)).toEqual(v1Setup.checks ?? []);
    expect(setupTable.description.startsWith(v1Setup.description)).toBe(true);
    for (const key of Object.keys(v1Setup).filter(
      (each) => !["description", "source", "columns", "foreignKeys", "checks"].includes(each),
    ))
      expect(setupTable[key], key).toEqual(v1Setup[key]);
    expect(setupTable.columns.slice(v1Setup.columns.length).map((column) => column.name)).toEqual([
      "signup_claim",
      "claimed_by_person_id",
    ]);
  });

  it("reads rule 8's body from the README", () => {
    expect(must(RULE_8_BODY, "README rule 8's body")).toContain(`constraint = '${SET_ONCE}'`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// b to e. On PostgreSQL with every migration applied, 0040 among them

describe("K-23 v1.1 on PostgreSQL with every migration applied (T-1553's 0040 among them)", () => {
  beforeAll(async () => {
    db = await createTestDatabase({ name: "business_setup_v1_1", client: { max: 1 }, database: "own" });
    qualified = `${db.schema}.${TABLE}`;
    migratedChecks = [
      ...(await db.sql<{ name: string; expression: string }[]>`
        select c.conname::text as name, pg_get_expr(c.conbin, c.conrelid) as expression
        from pg_constraint c
        where c.conrelid = to_regclass(${qualified}) and c.contype = 'c'
        order by c.conname
      `),
    ];
  }, 180_000);

  afterAll(async () => {
    await db.drop();
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("b. the catalog of business_setup against v1.1's list as 0040 makes it", () => {
    const TYPE_NAMES: Readonly<Record<string, string>> = {
      text: "text",
      boolean: "boolean",
      integer: "integer",
      timestamptz: "timestamp with time zone",
    };

    it(
      "holds the list's columns in its order, with their types, nulls and defaults: signup_claim then claimed_by_person_id after version, nullable, no default",
      SLOW,
      async () => {
        const found = await db.sql<
          { name: string; type: string; notNull: boolean; defaultValue: string | null }[]
        >`
        select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
               pg_get_expr(d.adbin, d.adrelid) as "defaultValue"
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass(${qualified}) and a.attnum > 0 and not a.attisdropped
        order by a.attnum
      `;
        expect([...found]).toEqual(
          setupTable.columns.map((column) => ({
            name: column.name,
            type: must(TYPE_NAMES[column.type], `a PostgreSQL name for ${column.type}`),
            notNull: !column.null,
            defaultValue: column.default ?? null,
          })),
        );
        expect(found.slice(-3)).toEqual([
          { name: "version", type: "integer", notNull: true, defaultValue: "1" },
          { name: "signup_claim", type: "text", notNull: false, defaultValue: null },
          { name: "claimed_by_person_id", type: "text", notNull: false, defaultValue: null },
        ]);
      },
    );

    it(
      "holds the list's foreign keys, business_setup_claimed_by_fk among them (to persons(id), on delete restrict), validated, and its CHECKs by name, validated",
      SLOW,
      async () => {
        const found = await db.sql<{ name: string; kind: string; definition: string; validated: boolean }[]>`
        select conname::text as name, contype::text as kind, pg_get_constraintdef(oid) as definition,
               convalidated as validated
        from pg_constraint where conrelid = to_regclass(${qualified}) and contype in ('f', 'c')
        order by conname
      `;
        const ofKind = (kind: string) => found.filter((constraint) => constraint.kind === kind);
        expect(
          ofKind("f").map(({ name, definition, validated }) => ({ name, definition, validated })),
        ).toEqual(
          sorted((setupTable.foreignKeys ?? []).map((key) => key.name)).map((name) => {
            const key = must((setupTable.foreignKeys ?? []).find((each) => each.name === name));
            return {
              name,
              definition: `FOREIGN KEY (${key.columns.join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.join(", ")}) ON DELETE ${(key.onDelete ?? "no action").toUpperCase()}`,
              validated: true,
            };
          }),
        );
        expect(
          must(found.find((constraint) => constraint.name === "business_setup_claimed_by_fk")).definition,
        ).toBe("FOREIGN KEY (claimed_by_person_id) REFERENCES persons(id) ON DELETE RESTRICT");
        expect(ofKind("c").map((check) => check.name)).toEqual(
          sorted(listedChecks.map((check) => check.name)),
        );
        expect(ofKind("c").filter((check) => !check.validated)).toEqual([]);
      },
    );

    it(
      "each CHECK is the list's own expression as pg_get_constraintdef prints both (the list's put on a temporary probe table), the two of v1.1 among them",
      SLOW,
      async () => {
        const definitions = async (tx: Tx, table: string): Promise<Record<string, string>> =>
          Object.fromEntries(
            (
              await tx<{ name: string; definition: string }[]>`
              select conname::text as name, pg_get_constraintdef(oid) as definition from pg_constraint
              where conrelid = to_regclass(${table}) and contype = 'c'
            `
            ).map((row) => [row.name, row.definition]),
          );
        const { listed, own } = await rolledBack(async (tx) => {
          await tx`create temporary table probe (like ${tx(TABLE)})`;
          for (const check of listedChecks)
            await tx.unsafe(`alter table probe add constraint ${check.name} check (${check.expression})`);
          return { listed: await definitions(tx, "probe"), own: await definitions(tx, qualified) };
        });
        expect(sorted(Object.keys(listed))).toEqual(sorted(listedChecks.map((check) => check.name)));
        expect(own).toEqual(listed);
        for (const name of ["business_setup_signup_claim_known", "business_setup_claim_with_person"])
          expect(own[name], name).toMatch(/^CHECK \(/);
      },
    );

    it(
      "has rule 8's trigger business_setup_claim_set_once, BEFORE UPDATE FOR EACH ROW, firing before business_setup_version_raised by name order",
      SLOW,
      async () => {
        const triggers = await db.sql<{ name: string; definition: string; enabled: string }[]>`
        select t.tgname::text as name, pg_get_triggerdef(t.oid) as definition, t.tgenabled::text as enabled
        from pg_trigger t where t.tgrelid = to_regclass(${qualified}) and not t.tgisinternal
        order by t.tgname
      `;
        expect(triggers.map((trigger) => trigger.name)).toEqual([SET_ONCE, VERSION_RAISED]);
        // PostgreSQL fires a table's BEFORE row triggers in name order (byte order, as a code-unit sort here).
        const names = triggers.map((trigger) => trigger.name);
        expect(sorted(names)).toEqual(names);
        expect(must(triggers[0]).definition).toMatch(
          /^CREATE TRIGGER business_setup_claim_set_once BEFORE UPDATE ON \S+ FOR EACH ROW EXECUTE FUNCTION \S*business_setup_claim_set_once\(\)$/,
        );
        expect(must(triggers[1]).definition).toMatch(
          /^CREATE TRIGGER business_setup_version_raised BEFORE UPDATE ON \S+ FOR EACH ROW EXECUTE FUNCTION \S*enforce_version_raise\(\)$/,
        );
        expect(triggers.map((trigger) => trigger.enabled)).toEqual(["O", "O"]);
      },
    );

    it(
      "an update that changes the claim without raising version is refused by business_setup_claim_set_once, which fires first; one that changes another column without raising it, by the version trigger",
      SLOW,
      async () => {
        const action = refusedActionOf(seedEntry.file);
        const set = { ...must(action.set) };
        delete set.version;
        const outcomes = await rolledBack(async (tx) => {
          await load(tx, chainRows(seedEntry.file));
          return inOrder(tx, action, [
            { ...action, set },
            { ...action, set: { no_money: true } },
          ]);
        });
        expect(outcomes.map((outcome) => outcome.refusal?.constraint ?? null)).toEqual([
          SET_ONCE,
          VERSION_RAISED,
        ]);
        expect(outcomes.map((outcome) => outcome.refusal?.sqlstate ?? null)).toEqual(["23514", "23514"]);
      },
    );

    it(
      "rule 8's function body, whitespace collapsed, is `begin <README rule 8's body> end;`",
      SLOW,
      async () => {
        const [fn] = await db.sql<{ body: string; language: string }[]>`
        select p.prosrc as body, l.lanname::text as language
        from pg_proc p join pg_language l on l.oid = p.prolang
        join pg_trigger t on t.tgfoid = p.oid
        where t.tgrelid = to_regclass(${qualified}) and t.tgname = ${SET_ONCE}
      `;
        expect(must(fn, "rule 8's function").language).toBe("plpgsql");
        expect(must(fn).body.replace(/\s+/gu, " ").trim()).toBe(`begin ${must(RULE_8_BODY)} end;`);
      },
    );
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("c. the seed row loads with its after chain and stores every value as given", () => {
    it("its chain is core's seed-business-head, then core's seed-person-roles, then seed-company-two-kinds, then its own rows", () => {
      expect(
        chainFiles(fixturePath(seedEntry.file)).map((file) => path.relative(CONTRACTS_ROOT, file)),
      ).toEqual([
        path.join("db-schema", "core", "fixtures", "seed-business-head.json"),
        path.join("db-schema", "core", "fixtures", "seed-person-roles.json"),
        path.join("db-schema", PART, "fixtures", "seed-company-two-kinds.json"),
        path.join("db-schema", PART, "fixtures", ...seedEntry.file.split("/")),
      ]);
    });

    it(
      "loads, and business_setup holds the row exactly as given (owner, person-sam, version 1)",
      SLOW,
      async () => {
        const stored = await rolledBack(async (tx) => {
          await load(tx, chainRows(seedEntry.file));
          return [...(await tx<Record<string, unknown>[]>`select * from ${tx(TABLE)}`)];
        });
        expect(stored).toHaveLength(1);
        const row = must(stored[0]);
        expect(Object.fromEntries(Object.keys(seedRow).map((column) => [column, row[column]]))).toEqual(
          seedRow,
        );
        expect(sorted(Object.keys(row))).toEqual(sorted(setupTable.columns.map((column) => column.name)));
        expect([row.signup_claim, row.claimed_by_person_id, row.version]).toEqual(["owner", "person-sam", 1]);
      },
    );
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("d. each refused v1.1 fixture, refused as its expect says, and its twin passing", () => {
    for (const entry of versionRefused) {
      it(
        `${entry.file}: refused as its expect says, acting as its role and scope; its row breaks the one rule it names and no other; put right, the same action passes`,
        SLOW,
        async () => {
          const run = runOf(entry.file);
          const twin = twinOf(entry);
          const named = must(run.action.expect.constraintOneOf?.[0]);
          const found = await rolledBack(async (tx) => {
            await load(tx, chainRows(entry.file, run.rows));
            const refusedOutcome = await attempt(tx, run.action);
            const row =
              run.action.action === "insert" ? must(run.action.values) : afterUpdate(run.rows, run.action);
            const broken = await brokenChecks(tx, row);
            return { refusedOutcome, broken };
          });
          expect(expectProblems(found.refusedOutcome, run.action.expect)).toEqual([]);
          // Of the table's CHECKs and rule 8: a CHECK's fixture breaks its CHECK alone (and an insert meets no trigger);
          // rule 8's fixture leaves a row that breaks no CHECK, so its refusal is the trigger's alone.
          expect(found.broken).toEqual(named === SET_ONCE ? [] : [named]);
          const twinFound = await rolledBack(async (tx) => {
            await load(tx, chainRows(entry.file, twin.rows));
            const outcome = await attempt(tx, twin.action);
            const row =
              twin.action.action === "insert"
                ? must(twin.action.values)
                : afterUpdate(twin.rows, twin.action);
            return { outcome, broken: await brokenChecks(tx, row) };
          });
          expect(expectProblems(twinFound.outcome, PASSES_ONE)).toEqual([]);
          expect(twinFound.broken).toEqual([]);
        },
      );
    }

    it("the refusal check fires on an outcome that misses its fixture: one that passes, one refused by another constraint", () => {
      const passes: Outcome = { rows: 1, refusal: null };
      const byOther: Outcome = {
        rows: null,
        refusal: { sqlstate: "23514", constraint: VERSION_RAISED, message: "" },
      };
      expect(expectProblems(passes, refusedBy(SET_ONCE))).toEqual(["must be refused with 23514, but passes"]);
      expect(expectProblems(byOther, refusedBy(SET_ONCE))).toEqual([
        `must be refused by one of ${SET_ONCE}, but by ${VERSION_RAISED}`,
      ]);
      expect(expectProblems(byOther, PASSES_ONE)).toEqual(["must touch 1 rows, but is refused: "]);
    });

    it("the probe of the CHECKs fires: a row that breaks two CHECKs names both", SLOW, async () => {
      const broken = await rolledBack(async (tx) =>
        brokenChecks(tx, { ...insertedRow, signup_claim: "unknown", claimed_by_person_id: null }),
      );
      expect(broken).toEqual(
        sorted(["business_setup_claim_with_person", "business_setup_signup_claim_known"]),
      );
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("e. edges (DL-618)", () => {
    const toolApi: Side = { role: "toolApi", scope: { businessId: businessId(insertedRow) } };
    const runtime: Side = { role: "runtime", scope: {} };
    const insertFile = refusedByConstraint("business_setup_signup_claim_known").file;
    const insertOf = (values: Values): Statement => ({
      action: "insert",
      table: TABLE,
      values: { ...insertedRow, ...values },
    });

    it(
      "signup_claim owner, helper and null pass; 'unknown', '' and 'Owner' are refused by business_setup_signup_claim_known",
      SLOW,
      async () => {
        const cases: [Values, Expect][] = [
          [{ signup_claim: "owner", claimed_by_person_id: "person-sam" }, PASSES_ONE],
          [{ signup_claim: "helper", claimed_by_person_id: "person-sam" }, PASSES_ONE],
          [{ signup_claim: null, claimed_by_person_id: null }, PASSES_ONE],
          [
            { signup_claim: "unknown", claimed_by_person_id: "person-sam" },
            refusedBy("business_setup_signup_claim_known"),
          ],
          [
            { signup_claim: "", claimed_by_person_id: "person-sam" },
            refusedBy("business_setup_signup_claim_known"),
          ],
          [
            { signup_claim: "Owner", claimed_by_person_id: "person-sam" },
            refusedBy("business_setup_signup_claim_known"),
          ],
        ];
        const outcomes = await rolledBack(async (tx) => {
          await load(tx, chainRows(insertFile));
          const out: Outcome[] = [];
          for (const [values] of cases)
            out.push(await attempt(tx, { ...toolApi, ...insertOf(values), expect: {} }));
          return out;
        });
        outcomes.forEach((outcome, n) => {
          const [values, wanted] = must(cases[n]);
          expect(expectProblems(outcome, wanted), JSON.stringify(values)).toEqual([]);
        });
      },
    );

    it(
      "a claim without its person and a person without a claim are refused by business_setup_claim_with_person; both null passes",
      SLOW,
      async () => {
        const cases: [Values, Expect][] = [
          [
            { signup_claim: "owner", claimed_by_person_id: null },
            refusedBy("business_setup_claim_with_person"),
          ],
          [
            { signup_claim: "helper", claimed_by_person_id: null },
            refusedBy("business_setup_claim_with_person"),
          ],
          [
            { signup_claim: null, claimed_by_person_id: "person-sam" },
            refusedBy("business_setup_claim_with_person"),
          ],
          [{ signup_claim: null, claimed_by_person_id: null }, PASSES_ONE],
        ];
        const outcomes = await rolledBack(async (tx) => {
          await load(tx, chainRows(insertFile));
          const out: Outcome[] = [];
          for (const [values] of cases)
            out.push(await attempt(tx, { ...toolApi, ...insertOf(values), expect: {} }));
          return out;
        });
        outcomes.forEach((outcome, n) => {
          const [values, wanted] = must(cases[n]);
          expect(expectProblems(outcome, wanted), JSON.stringify(values)).toEqual([]);
        });
      },
    );

    for (const side of [toolApi, runtime]) {
      const label = side.role === "toolApi" ? "rosie_app, scoped" : "rosie_job";
      const where = { business_id: businessId(seedRow) };
      const update = (set: Values): Statement => ({ action: "update", table: TABLE, set, where });

      it(
        `rule 8 as ${label}: on a claim on file, a change, a clear and a person swap (to another seeded person) are refused by the trigger; the same values and another column's update pass`,
        SLOW,
        async () => {
          const cases: [Values, Expect][] = [
            [{ signup_claim: "helper", version: 2 }, refusedBy(SET_ONCE)],
            [{ signup_claim: null, claimed_by_person_id: null, version: 2 }, refusedBy(SET_ONCE)],
            [{ claimed_by_person_id: "person-alex", version: 2 }, refusedBy(SET_ONCE)],
            [{ signup_claim: "owner", claimed_by_person_id: "person-sam", version: 2 }, PASSES_ONE],
            [{ no_money: true, version: 2 }, PASSES_ONE],
          ];
          const rows = chainRows(seedEntry.file);
          // The swapped-to person is seeded, so the foreign key is not what refuses the swap.
          expect(rows.some((row) => row.table === "persons" && row.values.id === "person-alex")).toBe(true);
          const outcomes = await rolledBack(async (tx) => {
            await load(tx, rows);
            const out: Outcome[] = [];
            for (const [set] of cases) out.push(must((await inOrder(tx, side, [update(set)]))[0]));
            return out;
          });
          outcomes.forEach((outcome, n) => {
            const [set, wanted] = must(cases[n]);
            expect(expectProblems(outcome, wanted), JSON.stringify(set)).toEqual([]);
          });
        },
      );

      it(
        `rule 8 as ${label}: a null claim is set once by an update; then a second change is refused and the same values pass`,
        SLOW,
        async () => {
          const twin = twinOf(seedEntry);
          const outcomes = await rolledBack(async (tx) => {
            await load(tx, chainRows(seedEntry.file, twin.rows));
            return inOrder(tx, side, [
              update({ signup_claim: "owner", claimed_by_person_id: "person-sam", version: 2 }),
              update({ signup_claim: "helper", version: 3 }),
              update({ claimed_by_person_id: "person-alex", version: 3 }),
              update({ signup_claim: "owner", claimed_by_person_id: "person-sam", version: 3 }),
            ]);
          });
          expect(outcomes.map((outcome) => expectProblems(outcome, PASSES_ONE).length === 0)).toEqual([
            true,
            false,
            false,
            true,
          ]);
          expect(expectProblems(must(outcomes[1]), refusedBy(SET_ONCE))).toEqual([]);
          expect(expectProblems(must(outcomes[2]), refusedBy(SET_ONCE))).toEqual([]);
        },
      );
    }
  });
});
