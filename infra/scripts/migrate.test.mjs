// Tests for infra/scripts/migrate.mjs, against the local PostGIS container (127.0.0.1:54329), in a throwaway schema.
// Run: node --test infra/scripts/migrate.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const migrate = path.join(here, "migrate.mjs");
const guard = path.join(repo, "infra/ci/migration-guard.mjs");
const initSql = path.join(repo, "db/migrations/0001_init.sql");
const url = process.env.DATABASE_URL ?? "postgres://rosie:rosie@127.0.0.1:54329/rosie";

const prefix = `t724_${randomBytes(3).toString("hex")}`;
const schemas = [];
let schema;
function freshSchema(tag) {
  schema = `${prefix}_${tag}`;
  schemas.push(schema);
}
const root = mkdtempSync(path.join(tmpdir(), "t724-"));
let sql;
let counter = 0;

const TABLE =
  "create table items (id int primary key, code text not null);\ninsert into items values (1, 'a'), (2, 'b');\n";

function folder(files) {
  counter += 1;
  const dir = path.join(root, `m${counter}`);
  mkdirSync(dir);
  copyFileSync(initSql, path.join(dir, "0001_init.sql"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function run(dir) {
  const env = { ...process.env, DATABASE_URL: url, DB_SCHEMA: schema, MIGRATIONS_DIR: dir };
  delete env.CI;
  const result = spawnSync("node", [migrate], { env, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const recorded = async () =>
  sql.unsafe(`select version, sha256 from ${schema}.schema_migrations order by version`);
const indexState = async (name) => {
  const rows = await sql`select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${schema} and c.relname = ${name}`;
  return Array.from(rows, (row) => ({ valid: row.valid }));
};

before(() => {
  sql = postgres(url, { max: 1, onnotice: () => undefined });
});

after(async () => {
  for (const name of schemas) {
    await sql.unsafe(`drop schema if exists ${name} cascade`);
  }
  await sql.end({ timeout: 5 });
  rmSync(root, { recursive: true, force: true });
});

describe("migrate.mjs: files of only CREATE INDEX CONCURRENTLY", () => {
  it("applies one statement at a time outside a transaction and records the file with its sha256", async () => {
    freshSchema("ok");
    const text =
      "-- two indexes\ncreate index concurrently if not exists items_code_idx on items (code);\n" +
      "create index concurrently if not exists items_id_code_idx on items (id, code);\n";
    const dir = folder({ "0002_items.sql": TABLE, "0003_indexes.sql": text });
    const result = run(dir);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(await indexState("items_code_idx"), [{ valid: true }]);
    assert.deepEqual(await indexState("items_id_code_idx"), [{ valid: true }]);
    const rows = await recorded();
    assert.deepEqual(
      rows.map((row) => row.version),
      ["0001", "0002", "0003"],
    );
    const expected = createHash("sha256")
      .update(readFileSync(path.join(dir, "0003_indexes.sql")))
      .digest("hex");
    assert.equal(rows[2].sha256, expected);
    const again = run(dir);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /up to date/);
  });

  it("refuses a file that mixes it with other statements, before anything runs", async () => {
    freshSchema("mixed");
    const mixed =
      "create table never_made (id int);\ncreate index concurrently if not exists never_idx on items (code);\n";
    const dir = folder({ "0002_items.sql": TABLE, "0003_mixed.sql": mixed });
    const result = run(dir);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /0003_mixed\.sql.*only CREATE INDEX CONCURRENTLY/s);
    const [present] = await sql`select to_regclass(${`${schema}.schema_migrations`}) as t`;
    assert.equal(present.t, null);
    const [row] = await sql`select to_regclass(${`${schema}.never_made`}) as t`;
    assert.equal(row.t, null);
    assert.deepEqual(await indexState("never_idx"), []);
  });

  it("stops on a failed concurrent index, leaves the file unrecorded, and a rerun drops the invalid index first", async () => {
    freshSchema("fail");
    const text =
      "create unique index concurrently if not exists items_code_unique on items (code);\n" +
      "create index concurrently if not exists items_after_idx on items (id);\n";
    // 0003 adds a duplicate code, so the unique build fails and leaves an invalid index.
    const dup = "insert into items values (3, 'a');\n";
    const dir = folder({ "0002_items.sql": TABLE, "0003_dup.sql": dup, "0004_unique.sql": text });
    const result = run(dir);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /0004_unique\.sql failed and was not recorded/);
    assert.deepEqual(await indexState("items_code_unique"), [{ valid: false }]);
    assert.deepEqual(await indexState("items_after_idx"), []);
    assert.equal(
      (await recorded()).some((row) => row.version === "0004"),
      false,
    );

    await sql.unsafe(`delete from ${schema}.items where id = 3`);
    const rerun = run(dir);
    assert.equal(rerun.code, 0, rerun.out);
    assert.match(rerun.out, /dropping invalid index/);
    assert.deepEqual(await indexState("items_code_unique"), [{ valid: true }]);
    assert.deepEqual(await indexState("items_after_idx"), [{ valid: true }]);
    assert.equal(
      (await recorded()).some((row) => row.version === "0004"),
      true,
    );
  });

  it("applies and records a marker file with one DROP INDEX CONCURRENTLY", async () => {
    freshSchema("drop");
    const make = "create index concurrently if not exists items_code_idx on items (code);\n";
    const drop = "-- migrate:no-transaction\ndrop index concurrently if exists items_code_idx;\n";
    const dir = folder({ "0002_items.sql": TABLE, "0003_make.sql": make, "0004_drop.sql": drop });
    const result = run(dir);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(await indexState("items_code_idx"), []);
    assert.equal(
      (await recorded()).some((row) => row.version === "0004"),
      true,
    );
  });

  it("refuses a marker file with several statements that are not all CREATE INDEX CONCURRENTLY", async () => {
    freshSchema("marker2");
    const two =
      "-- migrate:no-transaction\ndrop index concurrently if exists a_idx;\ndrop index concurrently if exists b_idx;\n";
    const dir = folder({ "0002_items.sql": TABLE, "0003_two.sql": two });
    const result = run(dir);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /0003_two\.sql/);
    const [present] = await sql`select to_regclass(${`${schema}.schema_migrations`}) as t`;
    assert.equal(present.t, null);
  });

  it("leaves an invalid index of the same name in another schema alone", async () => {
    freshSchema("other");
    const table = `t724_pub_${randomBytes(3).toString("hex")}`;
    await sql.unsafe(`create table public.${table} (code text)`);
    try {
      await sql.unsafe(`insert into public.${table} values ('a'), ('a')`);
      await assert.rejects(
        sql.unsafe(`create unique index concurrently items_pub_idx on public.${table} (code)`),
      );
      const invalid = async () =>
        Array.from(
          await sql`select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
            join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'items_pub_idx'`,
          (row) => ({ valid: row.valid }),
        );
      assert.deepEqual(await invalid(), [{ valid: false }]);
      const text = "create unique index concurrently if not exists items_pub_idx on items (code);\n";
      const dir = folder({ "0002_items.sql": TABLE, "0003_idx.sql": text });
      const result = run(dir);
      assert.equal(result.code, 0, result.out);
      assert.doesNotMatch(result.out, /dropping invalid index/);
      assert.deepEqual(await invalid(), [{ valid: false }]);
      assert.deepEqual(await indexState("items_pub_idx"), [{ valid: true }]);
    } finally {
      await sql.unsafe(`drop table if exists public.${table}`);
    }
  });
});

describe("npm run guard:migrations", () => {
  it("still fails CREATE INDEX without CONCURRENTLY on an existing table", () => {
    const dir = path.join(root, "guard");
    mkdirSync(path.join(dir, "db/migrations"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    copyFileSync(initSql, path.join(dir, "db/migrations/0001_init.sql"));
    writeFileSync(path.join(dir, "db/migrations/0002_items.sql"), TABLE);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("switch", "-q", "-c", "task/x");
    writeFileSync(
      path.join(dir, "db/migrations/0003_idx.sql"),
      "create index items_code_idx on items (code);\n",
    );
    git("add", ".");
    git("commit", "-q", "-m", "plain index");
    const result = spawnSync("node", [guard, "--base", "main"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /CREATE INDEX without CONCURRENTLY/);
  });
});
