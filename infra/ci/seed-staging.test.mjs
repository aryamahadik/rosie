// Tests for infra/scripts/seed-staging.sh, `npm run seed:staging` (T-571; build prompt 9.4 'Seeded state'; QUESTIONS
// NQ-DB-2; STATE note 67), run by `node --test "infra/ci/*.test.mjs"`. The script runs in throwaway checkouts
// (release-harness.mjs's releaseRoot, with this repository's db/ linked in, so T-201's runner and the seed sets run as
// they are) against throwaway local databases migrated as the staging database is, each one standing in for staging's:
// the database STAGING_DATABASE_URL names, from the environment or from the checkout's own made-up .dev.vars. No run
// gets this shell's STAGING_TEST_PHONES, and every value is made up: the test phones' numbers are in the fiction range
// 555-0100 to 555-0199 (rule 9), and every other database URL names a .invalid host, port 1 of this machine or a local
// database that does not exist.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, describe, it } from "node:test";

import {
  BAD_DATABASE_URLS,
  assertNoUrlPart,
  createThrowawayDatabase,
  releaseRoot,
} from "./release-harness.mjs";
import { copyScript } from "./script-harness.mjs";

// db/seeds imports its neighbours without an extension, as the bundler resolves them: a relative import from a .ts file
// is completed with .ts or /index.ts, as the seed runner does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL ?? "";
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // not this form: try the next one
        }
      }
      throw error;
    }
  },
});
const { LEFT_OUT, TEST_PHONES } = await import(
  new URL("../../db/seeds/staging-core.ts", import.meta.url).href
);
const { TEST_OWNER_1 } = await import(new URL("../../db/seeds/skeleton.ts", import.meta.url).href);

// D-017's sets, in their order (STATE note 67).
const D017 = ["core", "staging-core", "skeleton"];
const ON_STAGING = "public on the staging database (STAGING_DATABASE_URL)";
// The fixed fake handles staging-core falls back to, and the test phones it seeds at theirs (test owner 1 left out).
const FAKE_HANDLES = TEST_PHONES.map((phone) => phone.fakeNumber);
const CUSTOMER_FAKE_HANDLES = TEST_PHONES.filter((phone) => !LEFT_OUT.includes(phone.testPhoneId))
  .map((phone) => phone.fakeNumber)
  .sort();
const OWNER_FAKE_HANDLE = TEST_PHONES.find(
  (phone) => phone.testPhoneId === TEST_OWNER_1.testPhoneId,
).fakeNumber;
// STAGING_TEST_PHONES in the build Mac's form: made-up numbers in the fiction range, none of them a fixed fake handle.
const CONFIGURED = {
  "tp-02": "+18605550142",
  "tp-03": "+18605550143",
  "tp-04": "+18605550144",
  "tp-05": "+18605550145",
};
const CONFIGURED_VALUE = Object.entries(CONFIGURED)
  .map(([id, number]) => `${id}=${number}`)
  .join(",");
// Made up, as every URL here: a production database that does not exist (a .invalid host never resolves, RFC 6761),
// and a local database that does not exist.
const PRODUCTION_URL =
  "postgres://prod_owner_t571:Rk3mW8qT5vX2@db-t571-production.example.invalid:5432/t571_production_db";
const OTHER_LOCAL_URL = "postgres://rosie:rosie@127.0.0.1:54329/t571_not_staging";

/** A throwaway checkout with seed-staging.sh copied in beside the release scripts (lib.sh among them). */
function seedRoot(t, options) {
  const rig = releaseRoot(t, options);
  copyScript("seed-staging.sh", rig.root);
  return {
    ...rig,
    /** Runs seed-staging.sh with the variables given; this shell's STAGING_TEST_PHONES never reaches it. */
    seed: (args, extra = {}) =>
      rig.run("seed-staging.sh", args, { STAGING_TEST_PHONES: undefined, ...extra }),
  };
}

/** The sets the script started, in order, from its own line for each. */
const startedOf = (result) =>
  Array.from(result.stdout.matchAll(/^\[[^\]]+\] seed-staging: set (\S+)$/gm), ([, set]) => set);

/** The runner's runs, in order, from the first line of each: "<set> into <schema> on <where>". */
const runsOf = (result) =>
  Array.from(
    result.stdout.matchAll(/^seed: set (\S+) into schema (\S+) on (.+)$/gm),
    ([, set, schema, where]) => `${set} into ${schema} on ${where}`,
  );

/** Each run's last line: the set and its counts. */
const doneOf = (result) =>
  Array.from(
    result.stdout.matchAll(
      /^seed: done: set (\S+) into schema public: (\d+) rows? in \d+ tables? \((\d+) inserted, (\d+) kept\)$/gm,
    ),
    ([, set, rows, inserted, kept]) => ({
      set,
      rows: Number(rows),
      inserted: Number(inserted),
      kept: Number(kept),
    }),
  );

/** Every table of the database's public schema: its row count and an md5 of its rows, versions included. */
async function snapshot(sql) {
  const tables = await sql`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `;
  const out = {};
  for (const { name } of tables) {
    const [row] = await sql`
      select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as digest
      from ${sql("public")}.${sql(name)} as t
    `;
    out[name] = `${String(row.n)} rows, md5 ${row.digest}`;
  }
  return out;
}

/** The numbers among `numbers` that a phone row holds, in order. */
async function phonesAt(sql, numbers) {
  const rows = await sql`select number from phones where number in ${sql(numbers)} order by number`;
  return rows.map((row) => row.number);
}

/** The ids of the handles at `address`. */
async function handlesAt(sql, address) {
  const rows = await sql`select id from handles where address = ${address} order by id`;
  return rows.map((row) => row.id);
}

/**
 * Fails when a run's stdout or stderr holds any part of the database URL (its user, password, host, port as a whole
 * number, or database name) or a phone number: seven digits in a row, or the last seven of any of `numbers`.
 */
function assertNothingShown(result, url, numbers, what) {
  const { username, password, hostname, port, pathname } = new URL(url);
  const parts = [url, username, password, hostname, pathname.slice(1)].filter((part) => part !== "");
  assertNoUrlPart(result, { parts }, what);
  if (port !== "") {
    assert.doesNotMatch(result.output, new RegExp(`(?<![0-9])${port}(?![0-9])`), `${what}: the port`);
  }
  assert.doesNotMatch(result.output, /[0-9]{7}/, `${what}: seven digits in a row`);
  for (const number of numbers) {
    assert.equal(result.output.includes(number.slice(-7)), false, `${what}: a test phone's number`);
  }
}

describe("seed-staging.sh (npm run seed:staging) on a local database standing in for staging's", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;

  before(async () => {
    db = await createThrowawayDatabase("staging");
    rig = seedRoot(t);
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  const onStaging = (args, extra = {}) => rig.seed(args, { STAGING_DATABASE_URL: db.url, ...extra });

  it("seeds D-017's sets, core, staging-core and skeleton, one run each in that order, into schema public", async () => {
    const result = onStaging([]);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(startedOf(result), D017);
    assert.deepEqual(
      runsOf(result),
      D017.map((set) => `${set} into ${ON_STAGING}`),
    );
    const done = doneOf(result);
    assert.deepEqual(
      done.map((run) => run.set),
      D017,
    );
    // A fresh database: core and skeleton write every row of theirs, and staging-core keeps core's business heads and
    // writes the test phones' rows.
    for (const run of done) assert.ok(run.inserted > 0, `${run.set} wrote rows: ${result.output}`);
    assert.equal(done[0].kept, 0, result.output);
    assert.ok(done[1].kept > 0, result.output);
    assert.equal(done[2].kept, 0, result.output);
    assert.match(
      result.stdout,
      /seed-staging: STAGING_TEST_PHONES is not set: each test phone is seeded at its fixed fake handle \(555-01xx\)/,
    );
    assert.match(
      result.stdout,
      /seed-staging: done: sets core staging-core skeleton seeded into schema public on the staging database$/m,
    );
    assert.equal(result.stderr, "");
    // Each test phone but test owner 1 has a phone row at its fixed fake handle (staging-core); test owner 1's handle
    // is there with no phone row, so his JOIN is a first text (skeleton).
    assert.deepEqual(await phonesAt(db.sql, FAKE_HANDLES), CUSTOMER_FAKE_HANDLES);
    assert.deepEqual(await handlesAt(db.sql, OWNER_FAKE_HANDLE), [TEST_OWNER_1.handleId]);
    assertNothingShown(result, db.url, FAKE_HANDLES, "the first run");
  });

  it("a second run adds no rows and changes none: each set keeps every row of its own", async () => {
    const before = await snapshot(db.sql);
    const result = onStaging([]);
    assert.equal(result.status, 0, result.output);
    const done = doneOf(result);
    assert.deepEqual(
      done.map((run) => run.set),
      D017,
    );
    for (const run of done) {
      assert.equal(run.inserted, 0, `${run.set}: ${result.output}`);
      assert.equal(run.kept, run.rows, `${run.set}: ${result.output}`);
    }
    assert.deepEqual(await snapshot(db.sql), before);
    assertNothingShown(result, db.url, FAKE_HANDLES, "the second run");
  });

  it("--set runs the sets named, one run each in the order given; DATABASE_URL equal to STAGING_DATABASE_URL and DB_SCHEMA public are taken", async () => {
    const before = await snapshot(db.sql);
    const result = onStaging(["--set", "skeleton", "--set=core"], {
      DATABASE_URL: db.url,
      DB_SCHEMA: "public",
    });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(startedOf(result), ["skeleton", "core"]);
    assert.deepEqual(runsOf(result), [`skeleton into ${ON_STAGING}`, `core into ${ON_STAGING}`]);
    assert.deepEqual(
      doneOf(result).map((run) => `${run.set} ${String(run.inserted)} inserted`),
      ["skeleton 0 inserted", "core 0 inserted"],
    );
    assert.match(result.stdout, /seed-staging: done: sets skeleton core seeded into schema public/);
    assert.deepEqual(await snapshot(db.sql), before);
    assertNothingShown(result, db.url, FAKE_HANDLES, "--set skeleton --set=core");
  });

  it("misuse exits 2 before any set runs: every set name is checked first, and an argument it does not take is never echoed", async () => {
    const before = await snapshot(db.sql);
    const cases = [
      [["--set", "nope"], /no set nope: there is no db\/seeds\/nope\.ts; the sets: .*\bstaging-core\b/],
      [["--set", "core", "--set", "nope"], /no set nope: there is no db\/seeds\/nope\.ts/],
      [["--set", "lib"], /no set lib: there is no db\/seeds\/lib\.ts/],
      [["--set", "run"], /no set run: there is no db\/seeds\/run\.ts/],
      [["--set", "../core"], /a set name is not a plain lower-case name \(a-z, 0-9 and -\); the sets: /],
      [["--set", "core.int.test"], /a set name is not a plain lower-case name/],
      // Which of the two depends on how the shell's locale reads [a-z]; either way Core never reaches the runner.
      [["--set", "core", "--set", "Core"], /a set name is not a plain lower-case name|no set Core: /],
      [["--set"], /--set needs a set name/],
      [["--set", ""], /--set needs a set name/],
      [["--set="], /--set needs a set name/],
      [["core"], /an argument it does not take \(arguments are never echoed\)/],
      [["--set", "core", "--bogus"], /an argument it does not take/],
      [[PRODUCTION_URL], /an argument it does not take/],
    ];
    for (const [args, message] of cases) {
      const what = JSON.stringify(args);
      const result = onStaging(args);
      assert.equal(result.status, 2, `${what}: ${result.output}`);
      assert.match(result.stderr, message, what);
      assert.match(
        result.stderr,
        /^usage: seed-staging\.sh \[--set <name>\]\.\.\. \(with no --set: D-017's sets, core staging-core skeleton\)$/m,
        what,
      );
      assert.equal(result.stdout, "", `${what}: nothing ran`);
      assertNothingShown(result, PRODUCTION_URL, [], what);
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });

  it("refuses every target but the staging database (exit 1) before any set runs, printing no part of any URL", async () => {
    const before = await snapshot(db.sql);
    const cases = [
      [
        "DATABASE_URL names a production database",
        [],
        { DATABASE_URL: PRODUCTION_URL },
        /refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's/,
      ],
      [
        "DATABASE_URL names another local database",
        ["--set", "core"],
        { DATABASE_URL: OTHER_LOCAL_URL },
        /refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's/,
      ],
      [
        "STAGING_DATABASE_URL is not set, though DATABASE_URL names a local database",
        [],
        { STAGING_DATABASE_URL: undefined, DATABASE_URL: db.url },
        /refused: STAGING_DATABASE_URL is not set: staging has no database yet \(J-06\)/,
      ],
      ["--env production", ["--env", "production"], {}, /refused: seed-staging\.sh .* takes no --env/],
      ["--env=production", ["--env=production"], {}, /takes no --env: production is never seeded/],
      ["--env local", ["--set", "core", "--env", "local"], {}, /takes no --env/],
      ["--env staging", ["--env", "staging"], {}, /takes no --env/],
      [
        "DB_SCHEMA names a preview's schema",
        [],
        { DB_SCHEMA: "preview_t571" },
        /refused: DB_SCHEMA names a schema other than public: .*deploy-preview's to seed, C-010/,
      ],
    ];
    for (const [what, args, extra, message] of cases) {
      const result = onStaging(args, extra);
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.match(result.stderr, message, what);
      assert.match(result.stderr, /nothing was read or written$/m, what);
      assert.equal(result.stdout, "", `${what}: nothing ran`);
      for (const url of [db.url, PRODUCTION_URL, OTHER_LOCAL_URL]) assertNothingShown(result, url, [], what);
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });

  it("a staging database URL that does not parse, or names a database that does not answer, stops the run at its first set (exit 1), printing no part of the URL", async () => {
    const before = await snapshot(db.sql);
    // The runner's reason. A host not found is ENOTFOUND, or EAI_AGAIN where no name server answers.
    const reasons = {
      hash: /^seed: refused: DATABASE_URL does not parse: it holds a # /m,
      hashAfterDigits: /^seed: refused: DATABASE_URL does not parse: it holds a # /m,
      comment: /^seed: refused: DATABASE_URL does not parse: it holds a quote or a space /m,
      refused: /^seed: failed \(ECONNREFUSED\): .*\[redacted\]/m,
      notFound: /^seed: failed \((ENOTFOUND|EAI_AGAIN)\): .*\[redacted\]/m,
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const bad = BAD_DATABASE_URLS[name];
      // A .dev.vars line goes in a checkout of its own; a value from the environment runs in the shared one.
      const result =
        bad.devVars === undefined
          ? onStaging([], { STAGING_DATABASE_URL: bad.env })
          : seedRoot(t, { devVars: bad.devVars }).seed([]);
      assert.equal(result.status, 1, `${bad.name}: ${result.output}`);
      assert.match(result.stderr, reason, bad.name);
      assert.match(
        result.stderr,
        /seed-staging: FAILED at set core \(the seed runner's exit 1, for the reason above\): nothing of set core was written; the sets before it stay seeded, and the ones after it did not run/,
        bad.name,
      );
      assert.deepEqual(startedOf(result), ["core"], bad.name);
      assert.equal(doneOf(result).length, 0, bad.name);
      assertNoUrlPart(result, bad, bad.name);
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });
});

describe("seed-staging.sh: the test phones' numbers and the migrations, with a checkout's .dev.vars", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;

  before(async () => {
    db = await createThrowawayDatabase("staging_phones");
    // The build Mac's form: both read by name from the checkout's .dev.vars, as lib.sh's load_dev_var reads them.
    rig = seedRoot(t, {
      devVars: `STAGING_DATABASE_URL=${db.url}\nSTAGING_TEST_PHONES="${CONFIGURED_VALUE}"\n`,
    });
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  const numbers = Object.values(CONFIGURED);

  it("refuses a staging database that lacks a migration at its first set, writing nothing, and says to migrate it first", async () => {
    const before = await snapshot(db.sql);
    // The last migration, recorded under a version no file has (9999, a branch's number) while the run lasts.
    const [{ version }] = await db.sql`select max(version) as version from schema_migrations`;
    await db.sql`update schema_migrations set version = '9999' where version = ${version}`;
    try {
      const result = rig.seed([]);
      assert.equal(result.status, 1, result.output);
      assert.match(
        result.stdout,
        /seed-staging: the staging database must hold every migration of db\/migrations\/ \(npm run deploy:staging migrates it, step 1\)/,
      );
      assert.match(
        result.stderr,
        /^seed: refused: schema public on the staging database \(STAGING_DATABASE_URL\) lacks 1 of the \d+ migrations of db\/migrations\/ .*nothing was written$/m,
      );
      assert.match(
        result.stderr,
        /seed-staging: FAILED at set core .*\(a missing migration: npm run deploy:staging migrates the staging database, step 1\)/,
      );
      assert.deepEqual(startedOf(result), ["core"]);
      assertNothingShown(result, db.url, numbers, "a missing migration");
    } finally {
      await db.sql`update schema_migrations set version = ${version} where version = '9999'`;
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });

  it("a STAGING_TEST_PHONES value staging-core refuses stops the run there: nothing of it written, skeleton not run, no number shown", async () => {
    // The environment's value goes before the .dev.vars line (load_dev_var): it names a phone not on the roster.
    const result = rig.seed([], { STAGING_TEST_PHONES: "tp-02=+18605550142,tp-09=+18605550149" });
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(startedOf(result), ["core", "staging-core"]);
    assert.deepEqual(
      doneOf(result).map((run) => run.set),
      ["core"],
    );
    assert.match(
      result.stderr,
      /^seed: failed: the staging core seed refused, writing nothing: STAGING_TEST_PHONES entry 2 names no phone on the roster/m,
    );
    assert.match(result.stderr, /seed-staging: FAILED at set staging-core /);
    assert.deepEqual(await phonesAt(db.sql, [...numbers, "+18605550149", ...FAKE_HANDLES]), []);
    assert.deepEqual(await handlesAt(db.sql, OWNER_FAKE_HANDLE), []);
    assertNothingShown(result, db.url, [...numbers, "+18605550149"], "a refused STAGING_TEST_PHONES");
  });

  it("seeds each test phone at the number STAGING_TEST_PHONES gives, never shown; a second run adds no rows", async () => {
    const result = rig.seed([]);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(startedOf(result), D017);
    assert.deepEqual(
      runsOf(result),
      D017.map((set) => `${set} into ${ON_STAGING}`),
    );
    assert.match(
      result.stdout,
      /seed-staging: STAGING_TEST_PHONES is set: the test phones it names are seeded at its numbers \(never shown\)/,
    );
    assert.deepEqual(await phonesAt(db.sql, numbers), [...numbers].sort());
    assert.deepEqual(await phonesAt(db.sql, CUSTOMER_FAKE_HANDLES), []);
    assert.deepEqual(await handlesAt(db.sql, OWNER_FAKE_HANDLE), [TEST_OWNER_1.handleId]);
    assertNothingShown(result, db.url, numbers, "the first run");

    const before = await snapshot(db.sql);
    const again = rig.seed([]);
    assert.equal(again.status, 0, again.output);
    const done = doneOf(again);
    assert.deepEqual(
      done.map((run) => run.set),
      D017,
    );
    for (const run of done) assert.equal(run.inserted, 0, `${run.set}: ${again.output}`);
    assert.deepEqual(await snapshot(db.sql), before);
    assertNothingShown(again, db.url, numbers, "the second run");
  });
});
