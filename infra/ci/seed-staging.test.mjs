// Tests for infra/scripts/seed-staging.sh, `npm run seed:staging` (T-571; build prompt 9.4 'Seeded state'; QUESTIONS
// NQ-DB-2; STATE note 67; the check tester's token: T-1303, K-05 v1.12 default 105, CQ-214 (a), DL-561), run by
// `node --test "infra/ci/*.test.mjs"`. The script runs in throwaway checkouts (release-harness.mjs's releaseRoot, with
// this repository's db/ linked in, so T-201's runner and the seed sets run as they are) against throwaway local
// databases migrated as the staging database is, each one standing in for staging's: the database STAGING_DATABASE_URL
// names, from the environment or from the checkout's own made-up .dev.vars. No run gets this shell's
// STAGING_TEST_PHONES, STAGING_CHECK_TESTER_TOKEN or STAGING_CHECK_TESTER_TOKEN_SHA256, and every value is made up: the
// test phones' numbers are in the fiction range 555-0100 to 555-0199 (rule 9), every other database URL names a
// .invalid host, port 1 of this machine or a local database that does not exist, and each check tester's token is 32
// random bytes made in the run (or by the token's maker under test), so no key-shaped text sits in this file.
// A stand-in for node, first on PATH, is the real node with a recorder loaded first (as make-staging-secrets.test.mjs's
// is): every program the script starts (the seed runner, the token's hasher, the read of the session's end) runs as it
// is, and each says which names its environment holds and whether its environment or its arguments hold a watched
// token or hash, never the value.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  BAD_DATABASE_URLS,
  assertNoUrlPart,
  createThrowawayDatabase,
  releaseRoot,
} from "./release-harness.mjs";
import { REPO, SCRIPTS, cleanEnv, copyScript, write } from "./script-harness.mjs";

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
const { CHECK_TESTER, SESSION_DAYS, TOKEN_HASH_VARIABLE } = await import(
  new URL("../../db/seeds/check-tester.ts", import.meta.url).href
);

// D-017's sets, in their order (STATE note 67), the check tester's last (T-1303).
const D017 = ["core", "staging-core", "skeleton", "check-tester"];
const ON_STAGING = "public on the staging database (STAGING_DATABASE_URL)";
// The name the check tester's token is kept under, and the one its sha256 is handed on under (T-1302's set reads it).
const TOKEN_NAME = "STAGING_CHECK_TESTER_TOKEN";
const HASH_NAME = "STAGING_CHECK_TESTER_TOKEN_SHA256";
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

// The names seed-staging.sh, and lib.sh's load_dev_var that reads .dev.vars for it, keep variables of their own under:
// token and hash hold the token and its sha256, line and value a line of .dev.vars, ends the session's end; the others
// hold names, counts, the sets and the script's fixed texts (the ones in capitals). The last describe below reads them
// from the two files.
const OWN_NAMES = [
  "BASE64URL_SIGNS",
  "CHECK_TESTER_SET",
  "D017_SETS",
  "HEX_SIGNS",
  "ISO_TIME",
  "LAST_SIGNS",
  "SESSION_END",
  "SET_NAME",
  "SHA256_OF_INPUT",
  "USAGE",
  "ends",
  "file",
  "hash",
  "line",
  "list",
  "name",
  "named",
  "sets",
  "status",
  "token",
  "value",
  "with_tester",
];

/** A check tester's token in the made form, made up in the run: 32 random bytes as base64url, no token of anything. */
const madeUpToken = () => randomBytes(32).toString("base64url");
/** A text's sha256 as lower-case hex: how T-322 and the script hash a token. */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// The stand-in for node (CommonJS): the real node with this module loaded first (--require), so the program it was asked
// to run runs as it is, in the same process, with the same arguments and streams (standard input untouched). Before that
// it records one JSON line in $FAKE_LOG: which program it is, the names of its environment's variables, the names of
// those that hold a watched token, a watched hash or another watched text, and how many of its arguments do; never a
// value. $FAKE_NODE_WATCH is the file of the texts a run watches: tokens (and their hashes) and others (a caller's
// hash, which no command may get).
const FAKE_NODE = String.raw`"use strict";
const fs = require("node:fs");
const file = process.env.FAKE_NODE_WATCH || "";
const watch = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { tokens: [], hashes: [], others: [] };
const holds = (text, list) => list.some((item) => String(text).includes(item));
const args = [...process.execArgv, ...process.argv.slice(1)];
const e = process.execArgv.indexOf("-e");
const program = e >= 0 ? process.execArgv[e + 1] || "" : "";
const set = process.argv.indexOf("--set");
const kind = /\/db\/seeds\/run\.mjs$/.test(process.argv[1] || "")
  ? "runner " + process.argv[set + 1]
  : program.includes("createHash")
    ? "hasher"
    : program.includes("expires_at")
      ? "session end"
      : "other";
const names = Object.keys(process.env);
const entry = {
  tool: "node",
  kind,
  envNames: names,
  envHoldingToken: names.filter((name) => holds(process.env[name], watch.tokens)),
  envHoldingHash: names.filter((name) => holds(process.env[name], watch.hashes)),
  envHoldingOther: names.filter((name) => holds(process.env[name], watch.others)),
  argsHoldingToken: args.filter((arg) => holds(arg, watch.tokens)).length,
  argsHoldingHash: args.filter((arg) => holds(arg, watch.hashes)).length,
  argsHoldingOther: args.filter((arg) => holds(arg, watch.others)).length,
};
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
`;

/**
 * A throwaway checkout with seed-staging.sh copied in beside the release scripts (lib.sh among them), and the stand-in
 * for node first on PATH.
 */
function seedRoot(t, options) {
  const rig = releaseRoot(t, options);
  copyScript("seed-staging.sh", rig.root);
  const recorder = path.join(rig.dir, "fake", "node.cjs");
  write(recorder, FAKE_NODE);
  write(
    path.join(rig.dir, "bin", "node"),
    `#!/usr/bin/env bash\nexec "${process.execPath}" --require "${recorder}" "$@"\n`,
    0o755,
  );
  const watchFile = path.join(rig.dir, "watched.json");
  const nodeCalls = () => rig.calls().filter((call) => call.tool === "node");
  return {
    ...rig,
    /**
     * Runs seed-staging.sh with the variables given; this shell's STAGING_TEST_PHONES, token and hash never reach it.
     * Every node it starts is asked about `tokens` (the token extra gives, too) and their hashes, and about `others`.
     * The result's calls are the node calls of this run alone, in order.
     */
    seed: (args, extra = {}, { tokens = [], others = [] } = {}) => {
      const watched = [
        ...tokens,
        ...(typeof extra[TOKEN_NAME] === "string" ? [extra[TOKEN_NAME]] : []),
      ].filter((text) => text.trim() !== "");
      write(
        watchFile,
        JSON.stringify({
          tokens: watched,
          hashes: watched.map(sha256),
          others: others.filter((x) => x !== ""),
        }),
      );
      const from = nodeCalls().length;
      const result = rig.run("seed-staging.sh", args, {
        STAGING_TEST_PHONES: undefined,
        [TOKEN_NAME]: undefined,
        [HASH_NAME]: undefined,
        FAKE_NODE_WATCH: watchFile,
        ...extra,
      });
      return { ...result, calls: nodeCalls().slice(from) };
    },
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

/** The end of the check tester's session the run printed, or undefined. */
const printedEndOf = (result) =>
  /^\[[^\]]+\] seed-staging: the check tester's session ends at (\S+) \(30 days after /m.exec(
    result.stdout,
  )?.[1];

/** The programs the run started, in order. */
const kindsOf = (result) => result.calls.map((call) => call.kind);

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

/** The person whose live session a token's sha256 names now (K-22 session_for_token), or null. */
async function sessionPersonOf(sql, hash) {
  const rows = await sql`select person_id from session_for_token(${hash}, now())`;
  return rows.length === 0 ? null : rows[0].person_id;
}

/** The ids of the check tester's live team rows (K-36). */
async function liveTeamRows(sql) {
  const rows = await sql`
    select id from team_page_recipients where person_id = ${CHECK_TESTER.personId} and removed_at is null order by id
  `;
  return rows.map((row) => row.id);
}

/** When the session a token's sha256 names ends, as stored (ISO 8601). */
async function sessionEndOf(sql, hash) {
  const [row] = await sql`select expires_at from sessions where token_sha256 = ${hash}`;
  return row?.expires_at.toISOString();
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

/**
 * Fails when a run's stdout or stderr holds any of the texts or their sha256s, or any part of one ten signs long. The
 * failure names the fault, never the text.
 */
function assertNoTokenShown(result, texts, what) {
  for (const text of texts.filter((value) => value.trim() !== "")) {
    for (const value of [text, sha256(text)]) {
      const pieces = [];
      for (let at = 0; at + 10 <= value.length; at += 1) pieces.push(value.slice(at, at + 10));
      if (value.length < 10) pieces.push(value);
      assert.equal(
        pieces.some((piece) => result.output.includes(piece)),
        false,
        `${what}: the output holds a token, its hash or a part of one`,
      );
    }
  }
}

/**
 * Fails unless no command the run started holds a watched token (none of its arguments, and no variable of its
 * environment, a variable of the token's name included) or another watched text, and unless the token's hash reached
 * the check-tester set's run of the seed runner alone, by name: that run holds it in STAGING_CHECK_TESTER_TOKEN_SHA256
 * and nowhere else, and no other command holds it anywhere or has a variable of that name. `names`: variables no
 * command's environment may have (the script's own).
 */
function assertHandedOnByName(result, what, names = []) {
  assert.ok(result.calls.length > 0, `${what}: no command was recorded`);
  for (const [index, call] of result.calls.entries()) {
    const which = `${what}, command ${String(index + 1)} (${call.kind})`;
    const tester = call.kind === "runner check-tester";
    assert.deepEqual(call.envHoldingToken, [], `${which}: a variable of its environment holds the token`);
    assert.equal(call.argsHoldingToken, 0, `${which}: an argument holds the token`);
    assert.deepEqual(
      call.envHoldingOther,
      [],
      `${which}: a variable of its environment holds a caller's text`,
    );
    assert.equal(call.argsHoldingOther, 0, `${which}: an argument holds a caller's text`);
    assert.equal(call.argsHoldingHash, 0, `${which}: an argument holds the hash`);
    assert.deepEqual(call.envHoldingHash, tester ? [HASH_NAME] : [], `${which}: where the hash is`);
    assert.equal(call.envNames.includes(HASH_NAME), tester, `${which}: ${HASH_NAME} in its environment`);
    assert.deepEqual(
      [TOKEN_NAME, ...names].filter((name) => call.envNames.includes(name)),
      [],
      `${which}: its environment has the token's name or one of the script's own`,
    );
  }
}

/**
 * Fails unless a run seeded the check tester from the token's sha256: session_for_token answers the check tester for it,
 * its one team row is live, and the end printed is that session's, 30 days after it began.
 */
async function assertCheckTesterSeeded(sql, result, token, what) {
  const hash = sha256(token);
  assert.equal(await sessionPersonOf(sql, hash), CHECK_TESTER.personId, `${what}: the hash's session`);
  assert.deepEqual(await liveTeamRows(sql), [CHECK_TESTER.teamRowId], `${what}: the live team row`);
  const end = await sessionEndOf(sql, hash);
  assert.equal(printedEndOf(result), end, `${what}: the end printed`);
  // SESSION_DAYS days, give or take the hour a change of clocks in the database's time zone moves it.
  const [{ hours }] = await sql`
    select extract(epoch from (expires_at - started_at)) / 3600 as hours from sessions where token_sha256 = ${hash}
  `;
  assert.ok(Math.abs(Number(hours) - SESSION_DAYS * 24) <= 1, `${what}: the session's length`);
}

describe("seed-staging.sh (npm run seed:staging) on a local database standing in for staging's", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;
  // The check tester's token of these runs (made up), and one that later replaces it.
  const token = madeUpToken();
  const nextToken = madeUpToken();

  before(async () => {
    db = await createThrowawayDatabase("staging");
    rig = seedRoot(t);
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  const onStaging = (args, extra = {}, watch = {}) =>
    rig.seed(args, { STAGING_DATABASE_URL: db.url, ...extra }, watch);

  it("the hash's name is the one T-1302's set reads", () => {
    assert.equal(TOKEN_HASH_VARIABLE, HASH_NAME);
  });

  it("seeds D-017's sets, core, staging-core, skeleton and check-tester, one run each in that order, into schema public; the check tester's session comes from the token's sha256, handed to that set alone, by name", async () => {
    const result = onStaging([], { [TOKEN_NAME]: token });
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
    // A fresh database: core, skeleton and check-tester write every row of theirs, and staging-core keeps core's
    // business heads and writes the test phones' rows.
    for (const run of done) assert.ok(run.inserted > 0, `${run.set} wrote rows: ${result.output}`);
    assert.equal(done[0].kept, 0, result.output);
    assert.ok(done[1].kept > 0, result.output);
    assert.equal(done[2].kept, 0, result.output);
    assert.equal(done[3].kept, 0, result.output);
    assert.match(
      result.stdout,
      /seed-staging: STAGING_TEST_PHONES is not set: each test phone is seeded at its fixed fake handle \(555-01xx\)/,
    );
    assert.match(
      result.stdout,
      /seed-staging: check-tester gets the sha256 of the check tester's token \(STAGING_CHECK_TESTER_TOKEN\) by name, as STAGING_CHECK_TESTER_TOKEN_SHA256: neither is shown, and no other command gets either$/m,
    );
    assert.match(
      result.stdout,
      /seed-staging: done: sets core staging-core skeleton check-tester seeded into schema public on the staging database$/m,
    );
    assert.equal(result.stderr, "");
    // Each test phone but test owner 1 has a phone row at its fixed fake handle (staging-core); test owner 1's handle
    // is there with no phone row, so his JOIN is a first text (skeleton).
    assert.deepEqual(await phonesAt(db.sql, FAKE_HANDLES), CUSTOMER_FAKE_HANDLES);
    assert.deepEqual(await handlesAt(db.sql, OWNER_FAKE_HANDLE), [TEST_OWNER_1.handleId]);
    // The token was hashed first, before any set ran; its hash went to check-tester's run alone, by name, and the
    // session's end was read back after it.
    assert.deepEqual(kindsOf(result), ["hasher", ...D017.map((set) => `runner ${set}`), "session end"]);
    assertHandedOnByName(result, "the first run");
    await assertCheckTesterSeeded(db.sql, result, token, "the first run");
    assertNoTokenShown(result, [token], "the first run");
    assertNothingShown(result, db.url, FAKE_HANDLES, "the first run");
  });

  it("a second run adds no rows and changes none: each set keeps every row of its own", async () => {
    const before = await snapshot(db.sql);
    const result = onStaging([], { [TOKEN_NAME]: token });
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
    assertHandedOnByName(result, "the second run");
    await assertCheckTesterSeeded(db.sql, result, token, "the second run");
    assertNoTokenShown(result, [token], "the second run");
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
    assert.doesNotMatch(result.stdout, /check-tester gets|session ends/);
    assert.deepEqual(kindsOf(result), ["runner skeleton", "runner core"]);
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
      [["--set", "check-tester", "--set", "nope"], /no set nope: there is no db\/seeds\/nope\.ts/],
    ];
    for (const [args, message] of cases) {
      const what = JSON.stringify(args);
      const result = onStaging(args, { [TOKEN_NAME]: token });
      assert.equal(result.status, 2, `${what}: ${result.output}`);
      assert.match(result.stderr, message, what);
      assert.match(
        result.stderr,
        /^usage: seed-staging\.sh \[--set <name>\]\.\.\. \(with no --set: D-017's sets, core staging-core skeleton check-tester\)$/m,
        what,
      );
      assert.equal(result.stdout, "", `${what}: nothing ran`);
      assert.deepEqual(result.calls, [], `${what}: node was started`);
      assertNothingShown(result, PRODUCTION_URL, [], what);
      assertNoTokenShown(result, [token], what);
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
      [
        "DATABASE_URL names a production database, with a token",
        [],
        { DATABASE_URL: PRODUCTION_URL, [TOKEN_NAME]: token },
        /refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's/,
      ],
    ];
    for (const [what, args, extra, message] of cases) {
      const result = onStaging(args, extra);
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.match(result.stderr, message, what);
      assert.match(result.stderr, /nothing was read or written$/m, what);
      assert.equal(result.stdout, "", `${what}: nothing ran`);
      assert.deepEqual(result.calls, [], `${what}: node was started`);
      for (const url of [db.url, PRODUCTION_URL, OTHER_LOCAL_URL]) assertNothingShown(result, url, [], what);
      assertNoTokenShown(result, [token], what);
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
          ? onStaging([], { STAGING_DATABASE_URL: bad.env, [TOKEN_NAME]: token })
          : seedRoot(t, { devVars: bad.devVars }).seed([], { [TOKEN_NAME]: token });
      assert.equal(result.status, 1, `${bad.name}: ${result.output}`);
      assert.match(result.stderr, reason, bad.name);
      assert.match(
        result.stderr,
        /seed-staging: FAILED at set core \(the seed runner's exit 1, for the reason above\): nothing of set core was written; the sets before it stay seeded, and the ones after it did not run/,
        bad.name,
      );
      assert.deepEqual(startedOf(result), ["core"], bad.name);
      assert.equal(doneOf(result).length, 0, bad.name);
      assert.deepEqual(kindsOf(result), ["hasher", "runner core"], bad.name);
      assertHandedOnByName(result, bad.name);
      assertNoUrlPart(result, bad, bad.name);
      assertNoTokenShown(result, [token], bad.name);
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });

  it("refuses a run with check-tester before any set runs when the token is missing, or not in the form it is made in (exit 1): nothing is started or seeded, and no part of the value is shown", async () => {
    const before = await snapshot(db.sql);
    const MISSING =
      /^seed-staging\.sh: refused: STAGING_CHECK_TESTER_TOKEN is not set \(the check tester's token, read by name from the environment, else from \.dev\.vars\): the check-tester set takes its sha256, and the token is made on the build Mac with npm run check-tester:token:make \(the user's step\); no set ran: nothing was read or written\n$/;
    const WRONG_FORM =
      /^seed-staging\.sh: refused: STAGING_CHECK_TESTER_TOKEN is not the check tester's token in the form it is made in \(43 characters of base64url that are 32 random bytes, as npm run check-tester:token:make makes it; a sha256 in its place is refused too\), and no part of it is shown; no set ran: nothing was read or written\n$/;
    const swap = (text, at, sign) => `${text.slice(0, at)}${sign}${text.slice(at + 1)}`;
    const bytes = Buffer.from(token, "base64url");
    // [title, arguments, the token from the environment (undefined: none), the reason]
    const cases = [
      ["no token, D-017's sets", [], undefined, MISSING],
      ["an empty token", [], "", MISSING],
      ["no token, --set check-tester", ["--set", "check-tester"], undefined, MISSING],
      ["no token, a set before check-tester", ["--set", "core", "--set", "check-tester"], undefined, MISSING],
      ["the token's sha256 in its place", [], sha256(token), WRONG_FORM],
      ["the 32 bytes as hex", ["--set", "check-tester"], bytes.toString("hex"), WRONG_FORM],
      ["the 32 bytes as base64 (44 signs, one =)", [], bytes.toString("base64"), WRONG_FORM],
      ["the token with = after it", [], `${token}=`, WRONG_FORM],
      ["42 signs", [], token.slice(0, 42), WRONG_FORM],
      ["44 signs", [], `${token}A`, WRONG_FORM],
      ["31 bytes", [], randomBytes(31).toString("base64url"), WRONG_FORM],
      ["33 bytes", [], randomBytes(33).toString("base64url"), WRONG_FORM],
      ["48 bytes", [], randomBytes(48).toString("base64url"), WRONG_FORM],
      ["a last sign 32 bytes never end in", [], swap(token, 42, "B"), WRONG_FORM],
      ["a + of base64 inside", [], swap(token, 5, "+"), WRONG_FORM],
      ["a / of base64 inside", [], swap(token, 5, "/"), WRONG_FORM],
      ["a space inside", [], swap(token, 10, " "), WRONG_FORM],
      ["a letter that is not a base64url sign", [], swap(token, 5, "é"), WRONG_FORM],
      ["a space before it", [], ` ${token}`, WRONG_FORM],
      ["a line end after it", [], `${token}\n`, WRONG_FORM],
      ["in quotes", [], `"${token}"`, WRONG_FORM],
    ];
    for (const [title, args, value, reason] of cases) {
      const extra = value === undefined ? {} : { [TOKEN_NAME]: value };
      const result = onStaging(args, extra, { tokens: [token] });
      assert.equal(result.status, 1, `${title}: exit ${String(result.status)}`);
      assert.match(result.stderr, reason, title);
      assert.equal(result.stdout, "", `${title}: nothing ran`);
      assert.deepEqual(result.calls, [], `${title}: node was started`);
      assertNoTokenShown(result, [token, ...(value === undefined ? [] : [value])], title);
    }
    // From the checkout's .dev.vars by name, as lib.sh reads it: no value, a commented line or another name is no
    // token, and a value in another form is refused.
    for (const [title, line, reason] of [
      ["an empty line", `${TOKEN_NAME}=`, MISSING],
      ["an empty quoted line", `${TOKEN_NAME}=""`, MISSING],
      ["a line of spaces", `${TOKEN_NAME}=   `, MISSING],
      ["a commented line", `# ${TOKEN_NAME}=${token}`, MISSING],
      ["another name", `${TOKEN_NAME}_OLD=${token}`, MISSING],
      ["the sha256 in its place", `${TOKEN_NAME}=${sha256(token)}`, WRONG_FORM],
      ["quoted spaces", `${TOKEN_NAME}="  "`, WRONG_FORM],
      ["base64", `  export ${TOKEN_NAME}='${bytes.toString("base64")}'`, WRONG_FORM],
    ]) {
      const result = seedRoot(t, { devVars: `${line}\n` }).seed(
        [],
        { STAGING_DATABASE_URL: db.url },
        { tokens: [token] },
      );
      assert.equal(result.status, 1, `${title}: exit ${String(result.status)}`);
      assert.match(result.stderr, reason, title);
      assert.equal(result.stdout, "", `${title}: nothing ran`);
      assert.deepEqual(result.calls, [], `${title}: node was started`);
      assertNoTokenShown(result, [token, bytes.toString("base64")], title);
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });

  it("a run without check-tester reads no token, and a token and a hash in the caller's environment reach no command", async () => {
    const before = await snapshot(db.sql);
    const callersHash = sha256(madeUpToken());
    for (const [title, value] of [
      ["a token in the made form", token],
      ["a token in another form", sha256(token)],
    ]) {
      const result = onStaging(
        ["--set", "core"],
        { [TOKEN_NAME]: value, [HASH_NAME]: callersHash },
        { tokens: [token], others: [callersHash] },
      );
      assert.equal(result.status, 0, `${title}: ${result.output}`);
      assert.deepEqual(kindsOf(result), ["runner core"], title);
      assert.doesNotMatch(result.stdout, /check-tester gets|session ends/, title);
      assertHandedOnByName(result, title);
      assertNoTokenShown(result, [token, value, callersHash], title);
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });

  it("a STAGING_CHECK_TESTER_TOKEN_SHA256 in the caller's environment never reaches the set: the hash is made here, from the token", async () => {
    const otherToken = madeUpToken();
    const callersHash = sha256(otherToken);
    const before = await snapshot(db.sql);
    const result = onStaging(
      ["--set", "check-tester"],
      { [TOKEN_NAME]: token, [HASH_NAME]: callersHash },
      { others: [callersHash] },
    );
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(kindsOf(result), ["hasher", "runner check-tester", "session end"]);
    assertHandedOnByName(result, "a caller's hash");
    assert.deepEqual(
      doneOf(result).map((run) => `${run.set} ${String(run.inserted)} inserted`),
      ["check-tester 0 inserted"],
    );
    assert.equal(await sessionPersonOf(db.sql, callersHash), null);
    await assertCheckTesterSeeded(db.sql, result, token, "a caller's hash");
    assert.deepEqual(await snapshot(db.sql), before);
    assertNoTokenShown(result, [token, otherToken], "a caller's hash");
  });

  it("bash's tracing, allexport and keyword from the caller, and a caller's variables of the script's own names, hand nothing on and show nothing", async () => {
    // The names seed-staging.sh and load_dev_var keep variables of their own under (the test below reads them from the
    // two files), each holding made-up text in the caller's environment, which bash marks for export.
    const caller = Object.fromEntries(
      [...OWN_NAMES, "BASH_REMATCH", "ROOT", "CF"].map((name) => [
        name,
        `t1303 made-up caller text, ${name}`,
      ]),
    );
    for (const [title, extra] of [
      ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }],
      ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }],
      ["SHELLOPTS=keyword", { SHELLOPTS: "keyword" }],
      ["SHELLOPTS=allexport:keyword:xtrace", { SHELLOPTS: "allexport:keyword:xtrace" }],
      ["the caller's variables", caller],
      ["the caller's variables under allexport", { ...caller, SHELLOPTS: "allexport" }],
    ]) {
      const result = onStaging(["--set", "check-tester"], { [TOKEN_NAME]: token, ...extra });
      assert.equal(result.status, 0, `${title}: exit ${String(result.status)}`);
      assert.deepEqual(kindsOf(result), ["hasher", "runner check-tester", "session end"], title);
      assertHandedOnByName(result, title, [...OWN_NAMES, "ROOT", "CF"]);
      await assertCheckTesterSeeded(db.sql, result, token, title);
      assertNoTokenShown(result, [token], title);
    }
  });

  it("a new token replaces the old one: its session is written, the old one's ends, and the end printed is the new session's; the old token is then refused by the set, writing nothing", async () => {
    const result = onStaging(["--set", "check-tester"], { [TOKEN_NAME]: nextToken }, { tokens: [token] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(kindsOf(result), ["hasher", "runner check-tester", "session end"]);
    assert.deepEqual(
      doneOf(result).map((run) => `${run.set} ${String(run.inserted)} inserted`),
      ["check-tester 2 inserted"],
    );
    assertHandedOnByName(result, "a new token");
    assert.equal(await sessionPersonOf(db.sql, sha256(token)), null, "the old token's session is live");
    await assertCheckTesterSeeded(db.sql, result, nextToken, "a new token");
    assertNoTokenShown(result, [token, nextToken], "a new token");

    const before = await snapshot(db.sql);
    const again = onStaging(["--set", "check-tester"], { [TOKEN_NAME]: token }, { tokens: [nextToken] });
    assert.equal(again.status, 1, again.output);
    assert.match(
      again.stderr,
      /^seed: failed: the check tester seed refused, writing nothing: the check tester's session for the hash has ended or lapsed and is never brought back; /m,
    );
    assert.match(again.stderr, /seed-staging: FAILED at set check-tester \(the seed runner's exit 1, /);
    assert.equal(printedEndOf(again), undefined);
    assert.deepEqual(kindsOf(again), ["hasher", "runner check-tester"]);
    assertHandedOnByName(again, "the old token");
    assert.deepEqual(await snapshot(db.sql), before);
    assertNoTokenShown(again, [token, nextToken], "the old token");
  });
});

describe("seed-staging.sh: the test phones' numbers and the migrations, with a checkout's .dev.vars", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;
  const token = madeUpToken();

  before(async () => {
    db = await createThrowawayDatabase("staging_phones");
    // The build Mac's form: each read by name from the checkout's .dev.vars, as lib.sh's load_dev_var reads it (the
    // token's line exported and quoted).
    rig = seedRoot(t, {
      devVars: `STAGING_DATABASE_URL=${db.url}\nSTAGING_TEST_PHONES="${CONFIGURED_VALUE}"\n  export ${TOKEN_NAME}='${token}'\n`,
    });
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  const numbers = Object.values(CONFIGURED);
  const seed = (args, extra = {}) => rig.seed(args, extra, { tokens: [token] });

  it("refuses a staging database that lacks a migration at its first set, writing nothing, and says to migrate it first", async () => {
    const before = await snapshot(db.sql);
    // The last migration, recorded under a version no file has (9999, a branch's number) while the run lasts.
    const [{ version }] = await db.sql`select max(version) as version from schema_migrations`;
    await db.sql`update schema_migrations set version = '9999' where version = ${version}`;
    try {
      const result = seed([]);
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
      assert.deepEqual(kindsOf(result), ["hasher", "runner core"]);
      assertHandedOnByName(result, "a missing migration");
      assertNothingShown(result, db.url, numbers, "a missing migration");
      assertNoTokenShown(result, [token], "a missing migration");
    } finally {
      await db.sql`update schema_migrations set version = ${version} where version = '9999'`;
    }
    assert.deepEqual(await snapshot(db.sql), before);
  });

  it("a STAGING_TEST_PHONES value staging-core refuses stops the run there: nothing of it written, skeleton not run, no number shown", async () => {
    // The environment's value goes before the .dev.vars line (load_dev_var): it names a phone not on the roster.
    const result = seed([], { STAGING_TEST_PHONES: "tp-02=+18605550142,tp-09=+18605550149" });
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
    assert.deepEqual(kindsOf(result), ["hasher", "runner core", "runner staging-core"]);
    assertHandedOnByName(result, "a refused STAGING_TEST_PHONES");
    assert.deepEqual(await phonesAt(db.sql, [...numbers, "+18605550149", ...FAKE_HANDLES]), []);
    assert.deepEqual(await handlesAt(db.sql, OWNER_FAKE_HANDLE), []);
    assert.equal(await sessionPersonOf(db.sql, sha256(token)), null);
    assertNothingShown(result, db.url, [...numbers, "+18605550149"], "a refused STAGING_TEST_PHONES");
    assertNoTokenShown(result, [token], "a refused STAGING_TEST_PHONES");
  });

  it("seeds each test phone at the number STAGING_TEST_PHONES gives, never shown; a second run adds no rows", async () => {
    const result = seed([]);
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
    assertHandedOnByName(result, "the first run");
    await assertCheckTesterSeeded(db.sql, result, token, "the first run");
    assertNothingShown(result, db.url, numbers, "the first run");
    assertNoTokenShown(result, [token], "the first run");

    const before = await snapshot(db.sql);
    const again = seed([]);
    assert.equal(again.status, 0, again.output);
    const done = doneOf(again);
    assert.deepEqual(
      done.map((run) => run.set),
      D017,
    );
    for (const run of done) assert.equal(run.inserted, 0, `${run.set}: ${again.output}`);
    assert.deepEqual(await snapshot(db.sql), before);
    assertHandedOnByName(again, "the second run");
    await assertCheckTesterSeeded(db.sql, again, token, "the second run");
    assertNothingShown(again, db.url, numbers, "the second run");
    assertNoTokenShown(again, [token], "the second run");
  });
});

describe("seed-staging.sh with the token npm run check-tester:token:make makes", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;
  let token;

  before(async () => {
    db = await createThrowawayDatabase("check_tester_token");
    rig = seedRoot(t);
    // The maker, run in the throwaway checkout as the user runs it on the build Mac: it makes .dev.vars there.
    const maker = copyScript("make-check-tester-token.mjs", rig.root);
    const made = spawnSync(process.execPath, [maker], {
      cwd: rig.root,
      encoding: "utf8",
      env: cleanEnv(path.join(rig.dir, "home"), { [TOKEN_NAME]: undefined }),
    });
    assert.equal(made.status, 0, `the maker: exit ${String(made.status)}`);
    // The test reads its own throwaway checkout's .dev.vars, never this Mac's.
    token = /^STAGING_CHECK_TESTER_TOKEN=(.*)$/m.exec(
      readFileSync(path.join(rig.root, ".dev.vars"), "utf8"),
    )?.[1];
    assert.ok(token !== undefined, "the maker wrote no line of the name");
    assertNoTokenShown({ output: `${made.stdout}${made.stderr}` }, [token], "the maker");
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  it("T-1302's set refuses that token passed in place of its hash, before anything is written", async () => {
    const before = await snapshot(db.sql);
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        path.join(REPO, "db", "seeds", "run.mjs"),
        "--set",
        "check-tester",
      ],
      {
        cwd: REPO,
        encoding: "utf8",
        env: cleanEnv(path.join(rig.dir, "home"), {
          DATABASE_URL: db.url,
          STAGING_DATABASE_URL: db.url,
          DB_SCHEMA: "public",
          [HASH_NAME]: token,
        }),
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, `exit ${String(result.status)}`);
    assert.match(
      result.stderr,
      /^seed: failed: the check tester seed refused, writing nothing: STAGING_CHECK_TESTER_TOKEN_SHA256 is not 64 lower-case hex characters: it holds the token's sha256, never the token \(no part of its value is shown\)$/m,
    );
    assert.deepEqual(await snapshot(db.sql), before);
    assertNoTokenShown({ output }, [token], "the token in place of its hash");
  });

  it("seed:staging hands the set that token's sha256 by name, read from .dev.vars", async () => {
    const result = rig.seed(["--set", "check-tester"], { STAGING_DATABASE_URL: db.url }, { tokens: [token] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(kindsOf(result), ["hasher", "runner check-tester", "session end"]);
    assertHandedOnByName(result, "the maker's token");
    await assertCheckTesterSeeded(db.sql, result, token, "the maker's token");
    assertNoTokenShown(result, [token], "the maker's token");
  });

  it("a session end that cannot be read back stops the run after the set (exit 1), saying the set stays seeded, with no end printed", async () => {
    // A second live session of the check tester, written here as no seed run ever leaves it (made-up hash): the set
    // still answers for its own token, and the read finds two live sessions where it takes one.
    const other = sha256(madeUpToken());
    await db.sql`
      insert into proof_codes (id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash,
                               hash_key_name, sent_at, expires_at, used_at, version)
      values ('code-t1303-second', 'sign_in', ${CHECK_TESTER.personId}, null, ${CHECK_TESTER.emailHandleId}, 'email',
              ${"0".repeat(64)}, 'PROOF_CODE_HASH_KEY', now(), now() + interval '10 minutes', now(), 2)
    `;
    await db.sql`
      insert into sessions (id, person_id, token_sha256, device_sha256, proven_via, proof_code_id, started_at,
                            last_seen_at, expires_at)
      values ('session-t1303-second', ${CHECK_TESTER.personId}, ${other}, null, 'code', 'code-t1303-second', now(),
              now(), now() + interval '30 days')
    `;
    const before = await snapshot(db.sql);
    const result = rig.seed(
      ["--set", "check-tester", "--set", "core"],
      { STAGING_DATABASE_URL: db.url },
      { tokens: [token], others: [other] },
    );
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(
      doneOf(result).map((run) => `${run.set} ${String(run.inserted)} inserted`),
      ["check-tester 0 inserted"],
    );
    assert.match(result.stderr, /^seed-staging: the check tester holds 2 live sessions, not one$/m);
    assert.match(
      result.stderr,
      /seed-staging: FAILED after set check-tester: the end of the check tester's session could not be read back \(for the reason above\); every set before it, check-tester included, stays seeded, and the ones after it did not run\. Run npm run seed:staging -- --set check-tester again to read it: a second run writes nothing\.$/m,
    );
    assert.equal(printedEndOf(result), undefined);
    assert.deepEqual(startedOf(result), ["check-tester"], "core ran after the failed read");
    assert.deepEqual(kindsOf(result), ["hasher", "runner check-tester", "session end"]);
    assertHandedOnByName(result, "two live sessions");
    assert.deepEqual(await snapshot(db.sql), before);
    assertNoTokenShown(result, [token, other], "two live sessions");
  });
});

describe("seed-staging.sh keeps the token and its hash in variables of its own", () => {
  // The names given to one command alone, on its command line: the seed runner's and the session end's environment.
  const ONE_COMMAND = ["DATABASE_URL", HASH_NAME];
  const code = (file) =>
    readFileSync(path.join(SCRIPTS, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

  /**
   * The same names, read from the two files: every name, in small letters or capitals, that the script or load_dev_var
   * assigns, adds to, loops over or declares local, but those given to one command alone.
   */
  function ownNames() {
    const loader = /^load_dev_var\(\) \{\n([\s\S]*?)\n\}$/m.exec(code("lib.sh").join("\n"));
    assert.ok(loader, "lib.sh no longer holds: load_dev_var() { ... }");
    const text = `${code("seed-staging.sh").join("\n")}\n${loader[1]}`;
    const names = new Set();
    // name=... or name+=..., first on its line or after ;, &&, || or a case pattern's ).
    for (const [, name] of text.matchAll(/(?:^|;|&&|\|\||\))[ \t]*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm)) {
      names.add(name);
    }
    // for name in ...
    for (const [, name] of text.matchAll(/\bfor[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b/g)) names.add(name);
    // local name="..." other: each word of the declaration, up to its =.
    for (const [, words] of text.matchAll(/^[ \t]*local[ \t]+(.+)$/gm)) {
      for (const word of words.split(/[ \t]+/)) names.add(word.replace(/=.*$/, ""));
    }
    return [...names].filter((name) => !ONE_COMMAND.includes(name)).sort();
  }

  it("every variable the script works with is dropped before anything is sourced, read or started, and the token's and hash's names right after the token is taken from the environment", () => {
    assert.deepEqual(
      ownNames(),
      OWN_NAMES,
      "seed-staging.sh or lib.sh's load_dev_var works with another variable: add its name to the script's unset lines and to OWN_NAMES",
    );
    const lines = code("seed-staging.sh");
    assert.deepEqual(
      lines.slice(0, 4),
      ["set +x", "set +a", "set +k", "set -euo pipefail"],
      "the first commands",
    );
    // After the four set lines: the unset lines, the token taken from the environment, its names dropped, then lib.sh.
    const unsets = [];
    let at = 4;
    for (; /^unset -v [A-Za-z_][A-Za-z0-9_ ]*$/.test(lines[at]); at += 1) {
      unsets.push(...lines[at].slice("unset -v ".length).split(" "));
    }
    assert.deepEqual(
      [...unsets].sort(),
      [...OWN_NAMES, "BASH_REMATCH", "ROOT", "CF"].sort(),
      "the names on the unset lines",
    );
    assert.equal(new Set(unsets).size, unsets.length, "a name is on the unset lines twice");
    assert.deepEqual(
      lines.slice(at, at + 3),
      [
        'token="${STAGING_CHECK_TESTER_TOKEN:-}"',
        `unset -v ${TOKEN_NAME} ${HASH_NAME}`,
        'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"',
      ],
      "what follows the unset lines",
    );
  });

  it("no tracing, allexport or keyword is switched on, and the script has no here-document, here-string, file redirection, export or eval", () => {
    // The node programs, which are text the script hands node, and the usage line's <name> are left out.
    const text = code("seed-staging.sh")
      .join("\n")
      .replace(/^(SHA256_OF_INPUT|SESSION_END)='[\s\S]*?^'$/gm, "")
      .replace(/^USAGE=.*$/m, "");
    assert.doesNotMatch(text, /\bset\s+-[A-Za-z]*[xak]|xtrace|allexport|keyword/, "none is ever switched on");
    // bash 3.2 writes a here-document or here-string to a temporary file: no < at all.
    assert.doesNotMatch(text, /</, "no here-document, here-string or input redirection");
    assert.doesNotMatch(text.replaceAll("2>&1", "").replaceAll(">&2", ""), />/, "no redirection into a file");
    assert.doesNotMatch(text, /\b(mktemp|tee|eval)\b/);
    assert.doesNotMatch(text, /^[ \t]*(export|declare -x)\b/m, "an export");
    // The token goes to node on standard input alone, through a pipe from printf, a builtin.
    assert.match(
      text,
      /^ {2}hash="\$\(printf '%s' "\$token" \| node -e "\$SHA256_OF_INPUT"\)" \|\| status=\$\?$/m,
    );
  });
});
