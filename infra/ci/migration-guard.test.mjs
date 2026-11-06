// Tests for infra/ci/migration-guard.mjs, run in ci.yml by `node --test "infra/ci/*.test.mjs"`.
// Unit tests use inline SQL. End-to-end tests build throwaway git repositories in the system temp folder
// (never the real repository) with a fake origin/main, and run the guard as CI does.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkMigrations, checkSql, createdRelations } from "./migration-guard.mjs";

const GUARD = fileURLToPath(new URL("./migration-guard.mjs", import.meta.url));

describe("checkSql", () => {
  it("fails each contracting statement of factory spec section 5", () => {
    const cases = [
      ["DROP TABLE people;", "DROP TABLE"],
      ["ALTER TABLE people DROP COLUMN age;", "DROP COLUMN"],
      ["ALTER TABLE people DROP age;", "DROP COLUMN"],
      ["ALTER TABLE people DROP IF EXISTS age;", "DROP COLUMN"],
      ["DROP INDEX CONCURRENTLY people_age_idx;", "DROP INDEX"],
      ["ALTER TABLE people DROP CONSTRAINT people_age_check;", "DROP CONSTRAINT"],
      ["DROP TYPE mood;", "DROP TYPE"],
      ["DROP SCHEMA preview_old CASCADE;", "DROP SCHEMA"],
      ["ALTER TABLE people RENAME TO persons;", "RENAME"],
      ["ALTER TABLE people RENAME COLUMN phone TO mobile;", "RENAME"],
      ["ALTER TABLE people ALTER COLUMN age TYPE bigint;", "ALTER ... TYPE"],
      ["ALTER TABLE people ALTER age SET DATA TYPE bigint;", "ALTER ... TYPE"],
      ["ALTER TABLE people ALTER COLUMN age SET NOT NULL;", "ALTER ... SET NOT NULL"],
      ["ALTER TABLE people ALTER COLUMN age DROP DEFAULT;", "ALTER ... DROP DEFAULT"],
      ["TRUNCATE people;", "TRUNCATE"],
      ["TRUNCATE TABLE ONLY people;", "TRUNCATE"],
      ["DELETE FROM people WHERE id IS NULL;", "DELETE FROM"],
      ["WITH gone AS (DELETE FROM people RETURNING id) SELECT count(*) FROM gone;", "DELETE FROM"],
      [
        "CREATE INDEX people_age_idx ON people (age);",
        "CREATE INDEX without CONCURRENTLY on the existing table people",
      ],
      [
        "create unique index if not exists people_phone_key on public.people (phone);",
        "CREATE INDEX without CONCURRENTLY on the existing table public.people",
      ],
    ];
    for (const [sql, what] of cases) {
      assert.deepEqual(
        checkSql(sql).map((finding) => finding.what),
        [what],
        sql,
      );
    }
  });

  it("passes expanding statements", () => {
    const sql = `
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL);
      CREATE INDEX schema_migrations_applied_idx ON schema_migrations (applied_at);
      CREATE TABLE bookings (id uuid PRIMARY KEY, person_id uuid REFERENCES people (id) ON DELETE CASCADE);
      ALTER TABLE people ADD COLUMN nickname text;
      ALTER TABLE people ALTER COLUMN nickname DROP NOT NULL;
      ALTER TABLE people ALTER COLUMN nickname SET DEFAULT '';
      CREATE INDEX CONCURRENTLY people_nickname_idx ON people (nickname);
      ALTER TYPE mood ADD VALUE 'meh';
      GRANT SELECT, TRUNCATE ON bookings TO app;
      CREATE TRIGGER bookings_audit AFTER INSERT OR TRUNCATE ON bookings FOR EACH STATEMENT EXECUTE FUNCTION audit();
      ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
      CREATE POLICY bookings_owner ON bookings FOR DELETE USING (true);
      INSERT INTO moods (name) VALUES ('ok');
    `;
    assert.deepEqual(checkSql(sql, { newTables: new Set(createdRelations(sql)) }), []);
  });

  it("never checks comments, strings or function bodies, but does check DO blocks", () => {
    const sql = [
      "-- DROP TABLE people;",
      "/* RENAME /* nested */ TRUNCATE people */",
      "COMMENT ON TABLE bookings IS 'do not DROP TABLE or RENAME it';",
      "SELECT E'it''s \\' DELETE FROM x';",
      "CREATE FUNCTION purge() RETURNS void LANGUAGE sql AS $$ DELETE FROM sessions $$;",
      "CREATE FUNCTION wipe() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN TRUNCATE t; END $fn$;",
      "DO $$ BEGIN DROP TABLE old_things; END $$;",
    ].join("\n");
    assert.deepEqual(
      checkSql(sql).map((finding) => `${finding.line} ${finding.what}`),
      ["7 DROP TABLE"],
    );
  });

  it("reports the line of the offending clause", () => {
    const sql = "CREATE TABLE a (id int);\n\n-- note\nALTER TABLE b\n  DROP COLUMN c;\n";
    assert.deepEqual(
      checkSql(sql).map((finding) => finding.line),
      [5],
    );
  });
});

describe("checkMigrations", () => {
  const file = (content, sha = "new") => ({ sha, content });

  it("fails a changed or removed merged migration, even one named _contract_", () => {
    const base = new Map([
      ["db/migrations/0001_init.sql", "a1"],
      ["db/migrations/0002_contract_drop_x.sql", "b2"],
    ]);
    const branch = new Map([["db/migrations/0002_contract_drop_x.sql", file("DROP TABLE x;", "c3")]]);
    const result = checkMigrations(base, branch);
    assert.deepEqual(result.changed, ["db/migrations/0002_contract_drop_x.sql"]);
    assert.deepEqual(result.removed, ["db/migrations/0001_init.sql"]);
    assert.equal(result.errors.length, 2);
  });

  it("does not check merged migrations again when they are unchanged", () => {
    const base = new Map([["db/migrations/0003_contract_drop_y.sql", "d4"]]);
    const branch = new Map([["db/migrations/0003_contract_drop_y.sql", file("DROP TABLE y;", "d4")]]);
    assert.deepEqual(checkMigrations(base, branch).errors, []);
  });

  it("turns contracting statements into review notices in a _contract_ file", () => {
    const branch = new Map([
      ["db/migrations/9999_contract_drop_nickname.sql", file("ALTER TABLE people DROP COLUMN nickname;")],
    ]);
    const result = checkMigrations(new Map(), branch);
    assert.deepEqual(result.errors, []);
    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0].message, /the architect and the lead must review it/);
  });

  it("allows an index on a table that another new migration of the branch creates", () => {
    const branch = new Map([
      [
        "db/migrations/9999_a_clock_rows.sql",
        file("CREATE TABLE clock_rows (id uuid PRIMARY KEY, due timestamptz);"),
      ],
      [
        "db/migrations/9999_b_clock_rows_due.sql",
        file("CREATE INDEX clock_rows_due_idx ON clock_rows (due);"),
      ],
    ]);
    assert.deepEqual(checkMigrations(new Map(), branch).errors, []);
  });

  it("notes CREATE INDEX CONCURRENTLY outside a -- migrate:no-transaction file, which migrate cannot run", () => {
    const index = "CREATE INDEX CONCURRENTLY people_nickname_idx ON people (nickname);\n";
    const without = checkMigrations(new Map(), new Map([["db/migrations/9999_idx.sql", file(index)]]));
    assert.deepEqual(without.errors, []);
    assert.equal(without.notices.length, 1);
    assert.match(without.notices[0].message, /make "-- migrate:no-transaction" the first line/);
    const marked = file(`-- migrate:no-transaction\n${index}`);
    const withMarker = checkMigrations(new Map(), new Map([["db/migrations/9999_idx.sql", marked]]));
    assert.deepEqual(withMarker.notices, []);
    assert.deepEqual(withMarker.errors, []);
  });

  it("fails a contracting statement in a new migration, naming the file and line", () => {
    const branch = new Map([
      ["db/migrations/9999_tidy.sql", file("ALTER TABLE people\n  RENAME COLUMN a TO b;")],
    ]);
    const [error] = checkMigrations(new Map(), branch).errors;
    assert.equal(error.file, "db/migrations/9999_tidy.sql");
    assert.equal(error.line, 2);
    assert.match(error.message, /^RENAME is not expand-only \(build prompt 5\.4\)\./);
  });
});

// ---------------------------------------------------------------------------------------------------------
// End to end, in throwaway git repositories

function gitEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && !key.startsWith("GITHUB_")) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Guard Test",
    GIT_AUTHOR_EMAIL: "guard-test@example.invalid",
    GIT_COMMITTER_NAME: "Guard Test",
    GIT_COMMITTER_EMAIL: "guard-test@example.invalid",
    ...extra,
  };
}

function tempRepo(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rosie-migration-guard-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  return {
    git,
    write(name, content) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    markOriginMain: () => git("update-ref", "refs/remotes/origin/main", "HEAD"),
    guard: (args = [], extra = {}) =>
      spawnSync(process.execPath, [GUARD, ...args], {
        cwd: dir,
        env: { ...env, ...extra },
        encoding: "utf8",
      }),
  };
}

const INIT = `-- Bookkeeping only (D-000).
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, sha256 text NOT NULL);
CREATE EXTENSION IF NOT EXISTS pgcrypto;
`;

function repoWithInit(t) {
  const repo = tempRepo(t);
  repo.write("db/migrations/0001_init.sql", INIT);
  repo.write("README.md", "rosie\n");
  repo.commit("base");
  repo.markOriginMain();
  repo.git("switch", "-q", "-c", "task/T-100");
  return repo;
}

describe("migration guard, end to end", () => {
  it("passes a new expand-only migration that is not committed yet", (t) => {
    const repo = repoWithInit(t);
    repo.write("db/migrations/9999_add_nickname.sql", "ALTER TABLE people ADD COLUMN nickname text;\n");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /new: {5}db\/migrations\/9999_add_nickname\.sql/);
    assert.match(run.stdout, /migration guard: passed/);
  });

  it("fails a committed migration that drops a column, with its file and line", (t) => {
    const repo = repoWithInit(t);
    repo.write("db/migrations/9999_drop_age.sql", "-- tidy up\nALTER TABLE people DROP COLUMN age;\n");
    repo.commit("drop age");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL db\/migrations\/9999_drop_age\.sql:2 {2}DROP COLUMN is not expand-only/);
  });

  it("fails an edit to a migration that is already on origin/main", (t) => {
    const repo = repoWithInit(t);
    repo.write("db/migrations/0001_init.sql", `${INIT}-- one more line\n`);
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /0001_init\.sql is already on origin\/main: a merged migration never changes/);
  });

  it("passes a _contract_ migration with a notice for the architect and the lead", (t) => {
    const repo = repoWithInit(t);
    repo.write("db/migrations/9999_contract_drop_age.sql", "ALTER TABLE people DROP COLUMN age;\n");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /NOTE db\/migrations\/9999_contract_drop_age\.sql:1 {2}DROP COLUMN: a contracting change/,
    );
  });

  it("passes when there is no migrations folder", (t) => {
    const repo = tempRepo(t);
    repo.write("README.md", "rosie\n");
    repo.commit("base");
    repo.markOriginMain();
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /new: {5}none/);
  });

  it("stops with exit code 2 when origin/main is missing", (t) => {
    const repo = tempRepo(t);
    repo.write("db/migrations/0001_init.sql", INIT);
    repo.commit("base");
    const run = repo.guard();
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /origin\/main was not found/);
  });

  it("writes GitHub annotations when it runs in GitHub Actions", (t) => {
    const repo = repoWithInit(t);
    repo.write("db/migrations/9999_wipe.sql", "SELECT 1;\nTRUNCATE people;\n");
    const run = repo.guard([], { GITHUB_ACTIONS: "true" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /^::error file=db\/migrations\/9999_wipe\.sql,line=2,title=Migration guard::TRUNCATE is not/m,
    );
  });
});
