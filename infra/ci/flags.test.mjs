// Tests for infra/scripts/flags.sh and the flag sets of infra/flags/ (T-569; build prompt 5.4, deploy step 4; ADR-010;
// D-017 'Flag: skeleton (staging only)', 'Rollback: turn off the skeleton flag'), run by
// `node --test "infra/ci/*.test.mjs"`. The script runs in a throwaway checkout against a throwaway local database,
// migrated as the staging database is (release-harness.mjs). The Linq webhook route is the Worker's own
// (runtime/src/wiring/skeleton.ts, T-552), reading the skeleton flag through T-185's readFlag on that database; only
// the gateway's verify behind it is a stand-in, which turns every webhook away (401) once the route lets it through.
// The last describe (T-1343) puts a recorder in front of every command flags.sh starts, and shows that flags.mjs alone
// gets the database's URL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { assertNoUrlPart, badUrlRunners, createThrowawayDatabase, releaseRoot } from "./release-harness.mjs";
import { REPO, cleanEnv, namedIn, program, spies, tempDir, whereHeld } from "./script-harness.mjs";

// runtime/src imports its neighbours without an extension, as the bundler resolves them: a relative import from a .ts
// file is completed with .ts or /index.ts, as compiler/src/cli/commands/publish.ts does.
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
const { SKELETON_FLAG, skeletonLinqRoute } = await import(
  new URL("../../runtime/src/wiring/skeleton.ts", import.meta.url).href
);
const { createFlag, readFlag } = await import(new URL("../../db/repo/flags.ts", import.meta.url).href);

const readSet = (name) => JSON.parse(readFileSync(path.join(REPO, "infra", "flags", `${name}.json`), "utf8"));
// A fictional number (555-01xx), never a real person's (rule 9).
const TEST_PHONE = "+12025550143";

describe("the flag sets (infra/flags)", () => {
  it("staging's set turns the skeleton flag on; production's has it off and names every staging flag", () => {
    const staging = readSet("staging");
    const production = readSet("production");
    assert.equal(SKELETON_FLAG, "skeleton");
    assert.equal(staging.environment, "staging");
    assert.equal(production.environment, "production");
    assert.equal(staging.flags.skeleton, true);
    assert.equal(production.flags.skeleton, false);
    for (const flag of Object.keys(staging.flags))
      assert.ok(flag in production.flags, `production names ${flag}`);
  });
});

describe("flags.sh", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;

  before(async () => {
    db = await createThrowawayDatabase("flags");
    rig = releaseRoot(t);
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  const local = (...args) => rig.run("flags.sh", ["--env", "local", ...args], { DATABASE_URL: db.url });
  const skeleton = async () => (await readFlag(db.sql, SKELETON_FLAG)).enabled;
  const rows = async () =>
    Array.from(
      await db.sql`select name, scope, enabled, version from release_flags order by name, scope`,
      (row) => `${row.name} ${row.scope} ${row.enabled ? "on" : "off"} v${row.version}`,
    );

  /** One POST to the Worker's Linq webhook route with the skeleton flag read from the test's database. */
  const webhook = async () => {
    const verified = [];
    const response = await skeletonLinqRoute(
      new Request("https://rosie-staging.example.invalid/test/webhooks/linq", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      {
        gateway: {
          bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
          linq: {
            verifyWebhook: async (request) => {
              verified.push(request.webhookId);
              return { result: "rejected", reason: "badSignature" };
            },
          },
        },
        flags: { readFlag: (name, subject) => readFlag(db.sql, name, subject) },
        where: { environment: "staging", version: "t569" },
      },
    );
    return { status: response.status, error: (await response.json()).error, verified: verified.length };
  };

  it("with no flag row the skeleton flag reads off, and the route answers 404", async () => {
    assert.equal(await skeleton(), false);
    assert.deepEqual(await webhook(), { status: 404, error: "not_found", verified: 0 });
  });

  it("apply sets the staging flag set on local PostgreSQL: the skeleton flag on, recorded once", async () => {
    const record = path.join(rig.dir, "flags-on.txt");
    const result = local("apply", "--record", record);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /flags: on the local database \(--env local\)/);
    assert.match(result.stdout, /flags: skeleton: on \(a new global row, version 1\)/);
    assert.equal(await skeleton(), true);
    assert.equal(readFileSync(record, "utf8"), "skeleton\n");
    assert.deepEqual(await webhook(), { status: 401, error: "unauthorized", verified: 1 });

    const again = path.join(rig.dir, "flags-on-again.txt");
    const repeat = local("apply", "--record", again);
    assert.equal(repeat.status, 0, repeat.output);
    assert.match(repeat.stdout, /flags: skeleton: on, unchanged \(version 1\)/);
    assert.equal(existsSync(again), false, "a flag already on is not recorded as turned on");
    assert.deepEqual(await rows(), ["skeleton global on v1"]);
  });

  it("flags.sh off skeleton turns the flag off, and the gateway's Linq route then answers 404", async () => {
    assert.deepEqual(await webhook(), { status: 401, error: "unauthorized", verified: 1 });
    const result = local("off", "skeleton");
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /flags: skeleton global: off, was on \(version 2\)/);
    assert.match(result.stdout, /flags: skeleton: off in every scope \(1 row\)/);
    assert.equal(await skeleton(), false);
    assert.deepEqual(await webhook(), { status: 404, error: "not_found", verified: 0 });
  });

  it("off turns the flag off in every scope, a phone's row included, and never prints the number", async () => {
    const turnedOn = local("apply");
    assert.equal(turnedOn.status, 0, turnedOn.output);
    await createFlag(db.sql, { name: SKELETON_FLAG, scope: `phone:${TEST_PHONE}`, enabled: true });
    assert.equal((await readFlag(db.sql, SKELETON_FLAG, { phone: TEST_PHONE })).enabled, true);
    const listed = local("list");
    assert.equal(listed.status, 0, listed.output);
    assert.match(listed.stdout, /skeleton phone \(number not shown\): on \(version 1\)/);

    const result = local("off", "skeleton");
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /flags: skeleton: off in every scope \(2 rows\)/);
    assert.equal((await readFlag(db.sql, SKELETON_FLAG, { phone: TEST_PHONE })).enabled, false);
    assert.equal(await skeleton(), false);
    for (const output of [listed.output, result.output]) assert.doesNotMatch(output, /2025550143/);
    assert.deepEqual(await webhook(), { status: 404, error: "not_found", verified: 0 });
  });

  it("off refuses a name that no flag set names and no row holds (a typo), changing nothing", async () => {
    const before = await rows();
    const result = local("off", "skeletn");
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      /refused: no flag "skeletn": no row holds it and no flag set names it \(a typo\?\)/,
    );
    assert.deepEqual(await rows(), before);
  });

  it("has no on command: a flag goes on only through a flag set", async () => {
    const before = await rows();
    const result = local("on", "skeleton");
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /there is no on: a flag goes on only through a flag set/);
    assert.deepEqual(await rows(), before);
  });

  it("refuses --env production before anything is read or written", async () => {
    const before = await rows();
    for (const args of [
      ["--env", "production", "apply"],
      ["--env=production", "off", "skeleton"],
      ["apply", "--env", "production"],
      ["--env", "production", "list"],
    ]) {
      const result = rig.run("flags.sh", args, { STAGING_DATABASE_URL: db.url, DATABASE_URL: db.url });
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.output}`);
      assert.match(result.stderr, /refused: --env production is never run from here/, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
    }
    assert.deepEqual(await rows(), before);
  });

  it("staging: refused while STAGING_DATABASE_URL is not set (J-06)", () => {
    const result = rig.run("flags.sh", ["off", "skeleton"]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /STAGING_DATABASE_URL is not set: staging has no database yet \(J-06\)/);
  });

  it("staging: off skeleton is one command on the staging database", async () => {
    const turnedOn = rig.run("flags.sh", ["apply"], { STAGING_DATABASE_URL: db.url });
    assert.equal(turnedOn.status, 0, turnedOn.output);
    assert.match(turnedOn.stdout, /flags: on the staging database \(--env staging\)/);
    assert.equal(await skeleton(), true);
    const result = rig.run("flags.sh", ["off", "skeleton"], { STAGING_DATABASE_URL: db.url });
    assert.equal(result.status, 0, result.output);
    assert.equal(await skeleton(), false);
    assert.deepEqual(await webhook(), { status: 404, error: "not_found", verified: 0 });
  });

  it("refuses to apply when production's set does not state a staging flag", async () => {
    const file = path.join(rig.root, "infra", "flags", "production.json");
    const kept = readFileSync(file, "utf8");
    try {
      writeFileSync(file, JSON.stringify({ environment: "production", flags: {} }));
      const before = await rows();
      const result = local("apply");
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /infra\/flags\/production\.json does not name skeleton/);
      assert.deepEqual(await rows(), before);
    } finally {
      writeFileSync(file, kept);
    }
  });

  it("a staging database URL that does not parse is refused by every command before any client is built: no part of it printed, no flag written", async () => {
    const before = await rows();
    for (const runner of badUrlRunners(t, rig, ["hash", "hashAfterDigits", "comment"])) {
      for (const args of [["apply"], ["off", "skeleton"], ["list"]]) {
        const what = `${runner.bad.name}, ${args.join(" ")}`;
        const result = runner.run("flags.sh", args, { DATABASE_URL: db.url });
        assert.equal(result.status, 1, `${what}: ${result.output}`);
        assert.match(
          result.stderr,
          /^flags\.sh: refused: the database URL does not parse: it holds (a #|a quote or a space) .+; nothing was read or written$/m,
          what,
        );
        assertNoUrlPart(result, runner.bad, what);
        assert.deepEqual(await rows(), before, what);
      }
    }
  });

  it("a staging database that does not answer (a refused connection, a host not found) fails every command: no part of its URL printed, no flag written", async () => {
    const before = await rows();
    // A host not found is ENOTFOUND, or EAI_AGAIN where no name server answers.
    const codes = { refused: /\(ECONNREFUSED\)/, notFound: /\((ENOTFOUND|EAI_AGAIN)\)/ };
    for (const name of ["refused", "notFound"]) {
      const [runner] = badUrlRunners(t, rig, [name]);
      for (const args of [["apply"], ["off", "skeleton"], ["list"]]) {
        const what = `${runner.bad.name}, ${args.join(" ")}`;
        const result = runner.run("flags.sh", args, { DATABASE_URL: db.url });
        assert.equal(result.status, 1, `${what}: ${result.output}`);
        assert.match(result.stderr, /^flags\.sh: failed \([A-Z_]+\): .*\[redacted\]/m, what);
        assert.match(result.stderr, codes[name], what);
        assertNoUrlPart(result, runner.bad, what);
        assert.deepEqual(await rows(), before, what);
      }
    }
  });
});

// T-1343 (T-1310's new task b): flags.sh hands the database's URL to flags.mjs alone, as DATABASE_URL on its command
// line, and no other command it starts gets any database URL, in its environment or its arguments. A recorder
// (script-harness.mjs's spies) stands in front of every command it starts by name; PATH holds nothing else, so none
// starts unseen. The database is a throwaway local one; the caller's other URL is made up (a .invalid host never
// resolves, RFC 6761).
describe("flags.sh hands the database's URL to flags.mjs alone (T-1343)", () => {
  const OTHER_URL =
    "postgres://t1343_other_login:t1343-made-up-password@db-t1343-other.example.invalid:5432/t1343_other";
  const OTHER_PARTS = ["t1343_other_login", "t1343-made-up-password", "db-t1343-other.example.invalid"];
  const CALLER_TEXT = "t1343 made-up caller text";
  // Every command flags.sh and lib.sh start by name, but node (below).
  const COMMANDS = ["basename", "bash", "date", "dirname"];
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let watched;
  let fromEnv;
  let fromFile;

  const kindOf = (child) =>
    child.name === "node" && child.args.some((arg) => arg.endsWith("/infra/flags/flags.mjs"))
      ? "flags.mjs"
      : child.name;

  /** A release root (with a made-up .dev.vars when devVars is given) whose every command is spied. */
  const spiedRig = (devVars) => {
    const rig = releaseRoot(t, devVars === undefined ? {} : { devVars });
    const spy = spies(rig.dir, COMMANDS, { node: [process.execPath] });
    return {
      /** Runs flags.sh under the real bash, `bash` holding its options, with the variables given. */
      flags(args, { extra = {}, bash = [] } = {}) {
        spy.clear();
        const result = spawnSync(
          program("bash"),
          [...bash, path.join(rig.root, "infra", "scripts", "flags.sh"), ...args],
          {
            cwd: rig.root,
            encoding: "utf8",
            env: cleanEnv(path.join(rig.dir, "home"), { PATH: spy.bin, DB_SCHEMA: undefined, ...extra }),
          },
        );
        return { ...result, output: `${result.stdout}${result.stderr}`, children: spy.children() };
      },
    };
  };

  before(async () => {
    db = await createThrowawayDatabase("flags_urls");
    watched = [db.url, new URL(db.url).pathname.slice(1)];
    fromEnv = spiedRig();
    fromFile = spiedRig(`# made up\n  export STAGING_DATABASE_URL="${db.url}"\n`);
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  /**
   * Fails unless the run passed, flags.mjs alone holds the URL, as DATABASE_URL, no command holds it in an argument, no
   * other command has a database URL's name in its environment, none holds the caller's other URL or one of `others`,
   * and the output holds none of them.
   */
  function assertToFlagsAlone(result, what, others = []) {
    assert.equal(result.status, 0, `${what}: ${result.output}`);
    const kinds = new Set(result.children.map(kindOf));
    for (const kind of ["dirname", "date", "flags.mjs"])
      assert.ok(kinds.has(kind), `${what}: no ${kind} was recorded`);
    assert.deepEqual(
      whereHeld(result.children, watched, kindOf),
      ["flags.mjs: env DATABASE_URL"],
      `${what}: the URL`,
    );
    assert.deepEqual(
      namedIn(result.children, ["STAGING_DATABASE_URL", "DATABASE_URL"], kindOf),
      ["flags.mjs: DATABASE_URL"],
      `${what}: a database URL's name`,
    );
    const [flags] = result.children.filter((child) => kindOf(child) === "flags.mjs");
    assert.ok(flags.env.split("\n").includes(`DATABASE_URL=${db.url}`), `${what}: flags.mjs's DATABASE_URL`);
    assert.deepEqual(
      whereHeld(result.children, [...OTHER_PARTS, ...others], kindOf),
      [],
      `${what}: another text`,
    );
    for (const text of [...watched, ...OTHER_PARTS, ...others]) {
      assert.equal(result.output.includes(text), false, `${what}: the output holds a value`);
    }
  }

  it("--env staging, from the caller's environment beside a DATABASE_URL of another database, or from .dev.vars: flags.mjs alone gets the URL", () => {
    const fromEnvironment = fromEnv.flags(["apply"], {
      extra: { STAGING_DATABASE_URL: db.url, DATABASE_URL: OTHER_URL },
    });
    assertToFlagsAlone(fromEnvironment, "from the environment");
    assert.match(fromEnvironment.stdout, /flags: on the staging database \(--env staging\)/);
    assert.match(fromEnvironment.stdout, /flags: skeleton: on \(a new global row, version 1\)/);
    assertToFlagsAlone(fromFile.flags(["list"], { extra: { DATABASE_URL: OTHER_URL } }), "from .dev.vars");
  });

  it("--env local: the caller's DATABASE_URL goes to flags.mjs alone, and a STAGING_DATABASE_URL to no command", () => {
    const result = fromEnv.flags(["--env", "local", "list"], {
      extra: { DATABASE_URL: db.url, STAGING_DATABASE_URL: OTHER_URL },
    });
    assertToFlagsAlone(result, "--env local");
    assert.match(result.stdout, /flags: on the local database \(--env local\)/);
    assert.match(result.stdout, /skeleton global: on \(version 1\)/);
  });

  it("allexport, keyword and tracing from the caller, and the caller's variables of the script's own names, from either source: flags.mjs alone", () => {
    const caller = { staging_url: CALLER_TEXT, local_url: CALLER_TEXT, db_url: CALLER_TEXT };
    for (const [source, rig, extra] of [
      ["from the environment", fromEnv, { STAGING_DATABASE_URL: db.url, DATABASE_URL: OTHER_URL }],
      ["from .dev.vars", fromFile, { DATABASE_URL: OTHER_URL }],
    ]) {
      // [mode, its variables, bash's options, what standard error holds: a trace begins and ends at set +x]
      for (const [mode, variables, bash, stderr] of [
        ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, [], ""],
        ["bash -a -k", {}, ["-a", "-k"], ""],
        ["SHELLOPTS=allexport:keyword", { SHELLOPTS: "allexport:keyword" }, [], ""],
        ["the caller's variables under allexport", { ...caller, SHELLOPTS: "allexport" }, [], ""],
        ["bash -x", {}, ["-x"], "+ set +x\n"],
        ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, [], "+ set +x\n"],
      ]) {
        const what = `${mode}, ${source}`;
        const result = rig.flags(["list"], { extra: { ...extra, ...variables }, bash });
        assertToFlagsAlone(result, what, [CALLER_TEXT]);
        assert.equal(result.stderr, stderr, `${what}: standard error`);
      }
    }
  });

  it("a recorder keeps a command's environment and arguments, and the checks find a URL in either (the control for the checks above)", (t) => {
    const dir = tempDir(t, "flags-spy-control");
    const spy = spies(dir, ["dirname"]);
    spawnSync(path.join(spy.bin, "dirname"), [`/made-up/${OTHER_URL}`], {
      env: { PATH: spy.bin, DATABASE_URL: OTHER_URL },
      encoding: "utf8",
    });
    const children = spy.children();
    assert.deepEqual(whereHeld(children, OTHER_PARTS, kindOf), ["dirname: env DATABASE_URL, args 1"]);
    assert.deepEqual(namedIn(children, ["STAGING_DATABASE_URL", "DATABASE_URL"], kindOf), [
      "dirname: DATABASE_URL",
    ]);
  });

  // T-1349 (T-1343's security review, new task b): a DATABASE_REPLICA_URL in the caller's environment (db/repo/client.ts
  // reads it) leaves the script's environment before anything is started, as STAGING_DATABASE_URL and DATABASE_URL do.
  // Made up, as the other URL.
  const REPLICA_URL =
    "postgres://t1349_replica_login:t1349-made-up-replica-password@db-t1349-replica.example.invalid:5432/t1349_replica";
  const REPLICA_PARTS = [
    "t1349_replica_login",
    "t1349-made-up-replica-password",
    "db-t1349-replica.example.invalid",
    "t1349_replica",
  ];

  it("a DATABASE_REPLICA_URL of the caller's reaches no command, in its environment or its arguments, under allexport, bash -a -k or bash -x (T-1349)", () => {
    for (const [source, rig, extra] of [
      ["from the environment", fromEnv, { STAGING_DATABASE_URL: db.url }],
      ["from .dev.vars", fromFile, {}],
    ]) {
      // [mode, its variables, bash's options, what standard error holds: a trace begins and ends at set +x]
      for (const [mode, variables, bash, stderr] of [
        ["no option", {}, [], ""],
        ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, [], ""],
        ["bash -a -k", {}, ["-a", "-k"], ""],
        ["bash -x", {}, ["-x"], "+ set +x\n"],
      ]) {
        const what = `${mode}, ${source}`;
        const result = rig.flags(["list"], {
          extra: { ...extra, DATABASE_REPLICA_URL: REPLICA_URL, ...variables },
          bash,
        });
        assertToFlagsAlone(result, what, REPLICA_PARTS);
        assert.deepEqual(
          namedIn(result.children, ["DATABASE_REPLICA_URL"], kindOf),
          [],
          `${what}: DATABASE_REPLICA_URL's name`,
        );
        assert.equal(result.stderr, stderr, `${what}: standard error`);
      }
    }
  });

  it("a recorder keeps a DATABASE_REPLICA_URL in a command's environment or arguments, and the checks find it (the control for T-1349's checks)", (t) => {
    const dir = tempDir(t, "flags-replica-control");
    const spy = spies(dir, ["dirname"]);
    spawnSync(path.join(spy.bin, "dirname"), [`/made-up/${REPLICA_URL}`], {
      env: { PATH: spy.bin, DATABASE_REPLICA_URL: REPLICA_URL },
      encoding: "utf8",
    });
    const children = spy.children();
    assert.deepEqual(whereHeld(children, REPLICA_PARTS, kindOf), [
      "dirname: env DATABASE_REPLICA_URL, args 1",
    ]);
    assert.deepEqual(namedIn(children, ["DATABASE_REPLICA_URL"], kindOf), ["dirname: DATABASE_REPLICA_URL"]);
  });
});
