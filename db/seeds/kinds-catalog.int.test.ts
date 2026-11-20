// T-1469: the kinds catalog set (db/seeds/kinds-catalog.ts), against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/kinds-catalog`). Each top-level block migrates a fresh test schema of its own
// (db/repo/test-db.ts), and the kinds seed's schema below is one more; each is dropped at the end, and the shared public
// schema is never touched.
//
// The card's proofs (DL-961 card G; DL-988): on a schema with the migrations and the core seed alone (no setup seed),
// the set writes 243 kinds and two kind_flows rows per trade file, as rosie_job, and no other row; a second run inserts
// 0; its rows are byte-equal to the kinds seed's (kinds.ts after the core and setup seeds, in a schema of its own), each
// row compared as PostgreSQL writes it as text, every column and version included; a tampered trade file is refused
// before any write. The kinds seed's own tests are its own file's (kinds.int.test.ts, unchanged). Also: a catalog row
// that differs from its trade file is refused, naming its kind, and nothing is written or changed; the runner (T-201)
// finds the set by its name and prints row counts alone. Expected values are read here from the trade files themselves
// (node:fs, node:crypto and JSON.parse), never through the seed's reader or T-133's loader. Bytes are changed only in
// temporary copies of fixtures/master in the OS temp folder. The wrapping key the setup seed seals the demo owners' ID
// uploads with (in the kinds seed's schema) is made here from random bytes for each run and is never written down.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../repo/client";
import { DEFAULT_WRAPPING_KEY_NAME, type WrappingKeys } from "../repo/sealing";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { type KindsSeedResult, openTradeSet, seedKinds, TradeSetChecksumError } from "./kinds";
import {
  KindsCatalogSeedError,
  type KindsCatalogSeedResult,
  seedKindsCatalog,
  seedKindsCatalogFrom,
} from "./kinds-catalog";
import { FixtureAccessError } from "./lib/fixture-set";
import { seedSetupBusiness } from "./setup-business";

const SLOW = { timeout: 120_000 };
const SET = "kinds-catalog";
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RUNNER = path.join(REPO, "db/seeds/run.mjs");
const MASTER = path.join(REPO, "fixtures", "master");
const PROF = "engine/work/prof";
const CATALOG = ["kinds", "kind_flows"] as const;
const TABLES = [...CATALOG, "picked_kinds", "picked_kind_texts"] as const;
const EMPTY = { kinds: 0, kind_flows: 0, picked_kinds: 0, picked_kind_texts: 0 };
const CATALOG_ONLY = { kinds: 243, kind_flows: 486, picked_kinds: 0, picked_kind_texts: 0 };
/** The set's counts on a first run and on a run over its own rows. */
const WRITTEN = {
  kinds: { rows: 243, inserted: 243, kept: 0 },
  kind_flows: { rows: 486, inserted: 486, kept: 0 },
};
const KEPT = {
  kinds: { rows: 243, inserted: 0, kept: 243 },
  kind_flows: { rows: 486, inserted: 0, kept: 486 },
};

/** One wrapping key per run for the setup seed: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

type CatalogTable = (typeof CATALOG)[number];

interface TradeFile {
  id: string;
  name: string;
  style: string;
  pattern: string;
  plugin: Record<string, unknown>;
  money: Record<string, { main: string; combos: string[] }>;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sha256OfLines = (lines: readonly string[]): string =>
  createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

/** The trade files' ids, read here: each engine/work/prof/<id>.json, in code-point order. */
const TRADE_IDS = readdirSync(path.join(MASTER, PROF))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .sort();
/** How many files fixtures/master/SHA256SUMS lists, read here. */
const LISTED_FILES = readFileSync(path.join(MASTER, "SHA256SUMS"), "utf8")
  .split("\n")
  .filter((line) => /^[0-9a-f]{64} {2}\S/.test(line)).length;

/** One trade file, read here. */
const trade = (id: string): TradeFile => readJson(path.join(MASTER, PROF, `${id}.json`)) as TradeFile;

/** How many rows each table of the test schema holds, by table name. */
async function tableCounts(sql: Sql): Promise<Record<string, number>> {
  const tables = await sql<{ name: string }[]>`
    select tablename as name from pg_tables where schemaname = current_schema() order by tablename
  `;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(name)}`;
    counts[name] = row?.n ?? -1;
  }
  return counts;
}

async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Every row of the four tables of K-24 the kinds seed writes, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    kinds: [...(await sql`select * from kinds order by id`)],
    kind_flows: [...(await sql`select * from kind_flows order by kind_id, flow`)],
    picked_kinds: [...(await sql`select * from picked_kinds order by id`)],
    picked_kind_texts: [...(await sql`select * from picked_kind_texts order by picked_kind_id, pf_key`)],
  };
}

/** Every row of a catalog table as PostgreSQL writes the row as text (every column, version included), in key order. */
async function rowTexts(sql: Sql, table: CatalogTable): Promise<string[]> {
  const rows =
    table === "kinds"
      ? await sql<{ row: string }[]>`select k::text as row from kinds k order by k.id collate "C"`
      : await sql<{ row: string }[]>`
          select f::text as row from kind_flows f order by f.kind_id collate "C", f.flow collate "C"
        `;
  return rows.map((row) => row.row);
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

interface Copy {
  /** Its fixtures/ folder: the jail the copy is opened with. */
  fixtures: string;
  master: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/master at <temp>/fixtures/master. */
function copyOfMaster(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-kinds-catalog-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const master = path.join(fixtures, "master");
  cpSync(MASTER, master, { recursive: true });
  return { fixtures, master };
}

/** Rewrites one trade file of a copy and its SHA256SUMS line, so the copy still matches its list. */
function rewriteTrade(copy: Copy, id: string, change: (file: Record<string, unknown>) => void): void {
  const relative = `${PROF}/${id}.json`;
  const file = path.join(copy.master, relative);
  const parsed = readJson(file) as Record<string, unknown>;
  change(parsed);
  writeFileSync(file, `${JSON.stringify(parsed, null, 1)}\n`);
  const sumsFile = path.join(copy.master, "SHA256SUMS");
  const listed = readFileSync(sumsFile, "utf8")
    .split("\n")
    .map((line) => (line.endsWith(`  ${relative}`) ? `${sha256(file)}  ${relative}` : line));
  writeFileSync(sumsFile, listed.join("\n"));
}

/** Flips one bit of the byte in the middle of a file (doing it twice restores the file). */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

function seedFromCopy(sql: Sql, copy: Copy): Promise<KindsCatalogSeedResult> {
  return seedKindsCatalogFrom(sql, openTradeSet(copy.master, { jail: copy.fixtures }));
}

// The variables the runner reads: each child run sets only the ones it names.
const CHILD_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
]);

/** Runs `node db/seeds/run.mjs --set kinds-catalog` with this environment, less CHILD_VARIABLES, plus `env`. */
function runSet(env: Readonly<Record<string, string>>): Promise<Run> {
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
      [RUNNER, "--set", SET],
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

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the kinds catalog set, on a schema with the migrations and the core seed alone (no setup seed)", () => {
  let db: TestDatabase;
  let before: Record<string, number>;
  let first: KindsCatalogSeedResult;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_kinds_catalog" });
    await seedCore(db.sql);
    before = await tableCounts(db.sql);
    first = await seedKindsCatalog(db.sql);
  }, 120_000);

  // Dropping a schema can pass the 10 s hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("writes 243 kinds, one per trade file, and each kind's two kind_flows rows, A and B, as rosie_job, with no company kind or setup row there", async () => {
    expect(TRADE_IDS).toHaveLength(243);
    expect([before.company_kinds, before.business_setup, before.kinds, before.kind_flows]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(first.ranAs).toBe("rosie_job");
    expect(first.tables).toEqual(WRITTEN);
    expect(await rowCounts(db.sql)).toEqual(CATALOG_ONLY);
    const ids = await db.sql<{ id: string }[]>`select id from kinds`;
    expect(ids.map((row) => row.id).sort()).toEqual(TRADE_IDS);
    const flows = await db.sql<{ kind_id: string; flows: string[] }[]>`
      select kind_id, array_agg(flow order by flow) as flows from kind_flows group by kind_id
    `;
    expect(flows.map((row) => row.kind_id).sort()).toEqual(TRADE_IDS);
    expect(flows.filter((row) => row.flows.join(",") !== "A,B")).toEqual([]);
    expect(first.kinds.map((kind) => kind.kindId)).toEqual(TRADE_IDS);
    expect(first.tradeSet).toEqual({
      dir: realpathSync(MASTER),
      sumsSha256: sha256(path.join(MASTER, "SHA256SUMS")),
      filesChecked: LISTED_FILES,
    });
  });

  it("writes no other row: no picked_kinds or picked_kind_texts row, and every other table of the schema holds the rows it held before", async () => {
    expect(await tableCounts(db.sql)).toEqual({ ...before, kinds: 243, kind_flows: 486 });
    expect([before.picked_kinds, before.picked_kind_texts]).toEqual([0, 0]);
  });

  it("gives a kind its trade file's own values, read here from the files: barber's name, style, pattern, facts and flow A; insurance, which lists no facts, cpa.json's (MC C5); dog-walker's window of 2 hours in flow B", async () => {
    const barber = trade("barber");
    const [kind] = await db.sql<Record<string, unknown>[]>`select * from kinds where id = 'barber'`;
    expect(kind).toEqual({
      id: "barber",
      name: barber.name,
      style: barber.style,
      pattern: barber.pattern,
      facts: barber.plugin["pf.facts"],
      source: "trade_file",
      version: 1,
    });
    const [flowA] = await db.sql<Record<string, unknown>[]>`
      select * from kind_flows where kind_id = 'barber' and flow = 'A'
    `;
    expect(flowA).toMatchObject({
      main_combo: barber.money.A?.main,
      combos: barber.money.A?.combos,
      arrive: "setstart",
      cutoff: "24 hours before",
      version: 1,
    });
    const [insurance] = await db.sql<{ facts: string[] }[]>`select facts from kinds where id = 'insurance'`;
    expect(trade("insurance").plugin["pf.facts"]).toBeUndefined();
    expect(insurance?.facts).toEqual(trade("cpa").plugin["pf.facts"]);
    const [dogWalker] = await db.sql<Record<string, unknown>[]>`
      select arrive, arrive_window_hours, cutoff from kind_flows where kind_id = 'dog-walker' and flow = 'B'
    `;
    expect(dogWalker).toEqual({ arrive: "window", arrive_window_hours: 2, cutoff: "8pm the day before" });
  });

  it("is read whole by the Tool API role (rosie_app) under a business's scope, as S1-02's writer reads the catalog (DL-982)", async () => {
    const seen = await withBusiness(db.sql, "biz-demo-barber", async (tx) => {
      await tx`set local role rosie_app`;
      const [counts] = await tx<{ kinds: number; flows: number }[]>`
        select (select count(*)::int from kinds) as kinds, (select count(*)::int from kind_flows) as flows
      `;
      return counts;
    });
    expect(seen).toEqual({ kinds: 243, flows: 486 });
  });

  it(
    "running it twice leaves the same rows: the second run inserts 0, keeps 243 kinds and 486 kind_flows, and every row and version stays as it was",
    SLOW,
    async () => {
      const rows = await snapshot(db.sql);
      const counts = await tableCounts(db.sql);
      const second = await seedKindsCatalog(db.sql);
      expect(second.tables).toEqual(KEPT);
      expect(second.ranAs).toBe("rosie_job");
      expect(second.kinds).toEqual(first.kinds);
      expect(await snapshot(db.sql)).toEqual(rows);
      expect(await tableCounts(db.sql)).toEqual(counts);
    },
  );

  it(
    "writes a row that went missing again, as the first run wrote it, and changes nothing else",
    SLOW,
    async () => {
      const rows = await snapshot(db.sql);
      await db.sql`delete from kind_flows where kind_id = 'yoga' and flow = 'B'`;
      await db.sql`delete from kind_flows where kind_id = 'plumber'`;
      await db.sql`delete from kinds where id = 'plumber'`;
      const third = await seedKindsCatalog(db.sql);
      expect(third.tables).toEqual({
        kinds: { rows: 243, inserted: 1, kept: 242 },
        kind_flows: { rows: 486, inserted: 3, kept: 483 },
      });
      expect(await snapshot(db.sql)).toEqual(rows);
    },
  );

  describe("beside the kinds seed (kinds.ts), run in a schema of its own after the core and setup seeds", () => {
    let other: TestDatabase;
    let full: KindsSeedResult;

    beforeAll(async () => {
      other = await createTestDatabase({ name: "seeds_kinds_catalog_vs_kinds" });
      await seedCore(other.sql);
      await seedSetupBusiness(other.sql, { wrappingKeys: KEYS });
      full = await seedKinds(other.sql);
    }, 120_000);

    afterAll(async () => {
      await other.drop();
    }, 120_000);

    it("its kinds and kind_flows rows are byte-equal to the kinds seed's: every row, each as PostgreSQL writes the whole row as text, every column and version included", async () => {
      expect([full.tables.kinds, full.tables.kind_flows]).toEqual([WRITTEN.kinds, WRITTEN.kind_flows]);
      for (const table of CATALOG) {
        const catalogRows = await rowTexts(db.sql, table);
        const kindsSeedRows = await rowTexts(other.sql, table);
        expect(catalogRows, table).toHaveLength(table === "kinds" ? 243 : 486);
        expect(catalogRows, table).toEqual(kindsSeedRows);
        expect(sha256OfLines(catalogRows), table).toBe(sha256OfLines(kindsSeedRows));
      }
      expect(first.kinds).toEqual(full.kinds);
      expect(first.tradeSet).toEqual(full.tradeSet);
    });

    it(
      "over the kinds seed's rows it inserts 0, refuses nothing and changes no row, the demo shops' picks and their text blocks included",
      SLOW,
      async () => {
        const rows = await snapshot(other.sql);
        const counts = await tableCounts(other.sql);
        expect([counts.picked_kinds, counts.picked_kind_texts]).toEqual([243, 2673]);
        const run = await seedKindsCatalog(other.sql);
        expect(run.tables).toEqual(KEPT);
        expect(await snapshot(other.sql)).toEqual(rows);
        expect(await tableCounts(other.sql)).toEqual(counts);
      },
    );

    it(
      "the kinds seed after it, once the setup seed has run, keeps every catalog row it wrote (inserting none), writes the 243 demo shops' picks with their 2673 text blocks, and leaves the four tables equal to the kinds seed's own run, the catalog byte for byte",
      SLOW,
      async () => {
        await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
        const after = await seedKinds(db.sql);
        expect(after.tables).toEqual({
          ...KEPT,
          picked_kinds: { rows: 243, inserted: 243, kept: 0 },
          picked_kind_texts: { rows: 2673, inserted: 2673, kept: 0 },
        });
        expect(await snapshot(db.sql)).toEqual(await snapshot(other.sql));
        for (const table of CATALOG) {
          expect(await rowTexts(db.sql, table), table).toEqual(await rowTexts(other.sql, table));
        }
      },
    );
  });
});

describe("what the kinds catalog set refuses, on a schema with the migrations alone (no core or setup seed)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_kinds_catalog_checks" });
  }, 120_000);

  // Dropping a schema can pass the 10 s hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "checks the whole trade files' set against SHA256SUMS before any file is parsed or any row written: one changed byte in a trade file, a flow or a build script, an unlisted trade file and a listed one that is missing each stop it",
    SLOW,
    async () => {
      const copy = copyOfMaster();
      for (const changed of [
        `${PROF}/barber.json`,
        "engine/work/master/master-A.json",
        "engine/work/build/overlay-core.js",
      ]) {
        flipOneByte(path.join(copy.master, changed));
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error, changed).toBeInstanceOf(TradeSetChecksumError);
        expect((error as TradeSetChecksumError).problems, changed).toEqual([`changed: ${changed}`]);
        flipOneByte(path.join(copy.master, changed));
      }
      const extra = path.join(copy.master, PROF, "extra-trade.json");
      writeFileSync(extra, readFileSync(path.join(MASTER, PROF, "barber.json")));
      const unlisted = await refusal(seedFromCopy(db.sql, copy));
      expect(unlisted).toBeInstanceOf(TradeSetChecksumError);
      expect((unlisted as TradeSetChecksumError).problems).toEqual([
        `not in SHA256SUMS: ${PROF}/extra-trade.json`,
      ]);
      rmSync(extra);
      rmSync(path.join(copy.master, PROF, "yoga.json"));
      const missing = await refusal(seedFromCopy(db.sql, copy));
      expect(missing).toBeInstanceOf(TradeSetChecksumError);
      expect((missing as TradeSetChecksumError).problems).toEqual([`listed but missing: ${PROF}/yoga.json`]);
      expect(await rowCounts(db.sql)).toEqual(EMPTY);
    },
  );

  it(
    "refuses, naming the file, a trade file listed at its new hash that it does not know how to read, rather than guess (a facts list C5 does not cover, a main path the file does not list, an empty free-cancel time, an id that is not its file's name), before any row is written",
    SLOW,
    async () => {
      const cases: [string, (file: Record<string, unknown>) => void, string][] = [
        [
          "yoga",
          (file) => {
            Reflect.deleteProperty(file.plugin as object, "pf.facts");
          },
          "lists no facts",
        ],
        [
          "plumber",
          (file) => {
            const money = file.money as Record<string, Record<string, unknown>>;
            money.A = { ...money.A, main: "photos|full|none" };
          },
          "main path",
        ],
        [
          "barber",
          (file) => {
            (file.plugin as Record<string, unknown>)["pf.settings"] = { arrive: "setstart", cutoff: " " };
          },
          "free-cancel time",
        ],
        [
          "barber",
          (file) => {
            file.id = "barbers";
          },
          'expected "barber"',
        ],
      ];
      for (const [id, change, words] of cases) {
        const copy = copyOfMaster();
        rewriteTrade(copy, id, change);
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error.message, words).toContain(`${PROF}/${id}.json`);
        expect(error.message, words).toContain(words);
        expect(error, words).not.toBeInstanceOf(TradeSetChecksumError);
      }
      expect(await rowCounts(db.sql)).toEqual(EMPTY);
    },
  );

  it(
    "refuses an intact copy of the trade files' set that lies outside fixtures/, and a SHA256SUMS line that names a file outside the set, and writes nothing",
    SLOW,
    async () => {
      const copy = copyOfMaster();
      const outside = await refusal(seedKindsCatalog(db.sql, { tradesDir: copy.master }));
      expect(outside).toBeInstanceOf(FixtureAccessError);
      expect(outside.message).toContain("outside");
      const sumsFile = path.join(copy.master, "SHA256SUMS");
      writeFileSync(
        sumsFile,
        `${readFileSync(sumsFile, "utf8")}${sha256(path.join(MASTER, PROF, "barber.json"))}  ../v1/barber.json\n`,
      );
      const climbing = await refusal(seedFromCopy(db.sql, copy));
      expect(climbing).toBeInstanceOf(FixtureAccessError);
      expect(climbing.message).toContain(JSON.stringify("../v1/barber.json"));
      expect(await rowCounts(db.sql)).toEqual(EMPTY);
    },
  );

  it(
    "the runner (T-201) finds the set by its name and prints the row counts alone: the first run inserts 243 kinds and 486 kind_flows rows, a second inserts 0",
    SLOW,
    async () => {
      const local = { DATABASE_URL: resolvePrimaryUrl(), DB_SCHEMA: db.schema };
      const run = await runSet(local);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      expect(lines(run.stdout)).toEqual([
        `seed: set ${SET} into schema ${db.schema} on the local database`,
        "seed: kinds: 243 rows (243 inserted, 0 kept)",
        "seed: kind_flows: 486 rows (486 inserted, 0 kept)",
        `seed: done: set ${SET} into schema ${db.schema}: 729 rows in 2 tables (729 inserted, 0 kept)`,
      ]);
      const again = await runSet(local);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stderr).toBe("");
      expect(lines(again.stdout)).toEqual([
        `seed: set ${SET} into schema ${db.schema} on the local database`,
        "seed: kinds: 243 rows (0 inserted, 243 kept)",
        "seed: kind_flows: 486 rows (0 inserted, 486 kept)",
        `seed: done: set ${SET} into schema ${db.schema}: 729 rows in 2 tables (0 inserted, 729 kept)`,
      ]);
      expect(await rowCounts(db.sql)).toEqual(CATALOG_ONLY);
    },
  );

  it(
    "loads from an untouched copy opened the same way, so each refusal above had its one reason",
    SLOW,
    async () => {
      const result = await seedFromCopy(db.sql, copyOfMaster());
      expect(result.ranAs).toBe("rosie_job");
      expect(result.tables).toEqual(KEPT);
      expect(await rowCounts(db.sql)).toEqual(CATALOG_ONLY);
    },
  );

  it(
    "refuses, naming each kind id with the table and columns, catalog rows that differ from their trade files, and writes or changes nothing, through the runner too (exit 1); once the rows hold the files' values again it writes the missing row and keeps the others, their raised versions included",
    SLOW,
    async () => {
      const [barber] = await db.sql<{ name: string }[]>`select name from kinds where id = 'barber'`;
      expect(barber?.name).toBe(trade("barber").name);
      await db.sql`update kinds set name = 'Barber Shop Deluxe', version = version + 1 where id = 'barber'`;
      await db.sql`
        update kind_flows set arrive_window_hours = 3, version = version + 1
        where kind_id = 'dog-walker' and flow = 'B'
      `;
      await db.sql`
        update kind_flows set cutoff = '1 hour before', version = version + 1 where kind_id = 'plumber' and flow = 'B'
      `;
      await db.sql`delete from kind_flows where kind_id = 'yoga' and flow = 'B'`;
      const rows = await snapshot(db.sql);

      const error = await refusal(seedKindsCatalog(db.sql));
      expect(error).toBeInstanceOf(KindsCatalogSeedError);
      expect((error as KindsCatalogSeedError).kindIds).toEqual(["barber", "dog-walker", "plumber"]);
      expect(error.message).toBe(
        "the kinds catalog seed refused, writing nothing: the catalog rows of 3 kinds differ from the trade files, " +
          "and a catalog row is never changed here: barber (kinds: name), dog-walker (kind_flows B: " +
          "arrive_window_hours), plumber (kind_flows B: cutoff)",
      );
      expect(await snapshot(db.sql)).toEqual(rows);

      const run = await runSet({ DATABASE_URL: resolvePrimaryUrl(), DB_SCHEMA: db.schema });
      expect(run.code).toBe(1);
      expect(run.stdout).toBe(`seed: set ${SET} into schema ${db.schema} on the local database\n`);
      expect(lines(run.stderr)).toEqual([`seed: failed: ${error.message}`]);
      expect(await snapshot(db.sql)).toEqual(rows);

      await db.sql`update kinds set name = ${barber?.name ?? ""}, version = version + 1 where id = 'barber'`;
      await db.sql`
        update kind_flows set arrive_window_hours = 2, version = version + 1
        where kind_id = 'dog-walker' and flow = 'B'
      `;
      await db.sql`
        update kind_flows set cutoff = null, version = version + 1 where kind_id = 'plumber' and flow = 'B'
      `;
      const restored = await seedKindsCatalog(db.sql);
      expect(restored.tables).toEqual({
        kinds: { rows: 243, inserted: 0, kept: 243 },
        kind_flows: { rows: 486, inserted: 1, kept: 485 },
      });
      const versions = await db.sql<{ key: string; version: number }[]>`
        select id as key, version from kinds where version <> 1
        union all
        select kind_id || ' ' || flow, version from kind_flows where version <> 1
        order by 1
      `;
      expect(versions).toEqual([
        { key: "barber", version: 3 },
        { key: "dog-walker B", version: 3 },
        { key: "plumber B", version: 3 },
      ]);
      const [yogaB] = await db.sql<{ version: number }[]>`
        select version from kind_flows where kind_id = 'yoga' and flow = 'B'
      `;
      expect(yogaB?.version).toBe(1);
    },
  );
});
