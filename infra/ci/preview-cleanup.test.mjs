// Tests for infra/scripts/preview-cleanup.sh, `npm run preview:cleanup -- <branch>` (factory spec 6; build prompt 5.3;
// T-1343), run by `node --test "infra/ci/*.test.mjs"`. The script runs in a throwaway checkout (the script and lib.sh,
// with this repository's postgres package linked in for its node program) against a throwaway local database standing
// in for staging's, migrated as the staging database is (release-harness.mjs): the database STAGING_DATABASE_URL names,
// from the environment or from the checkout's own made-up .dev.vars. A recorder (script-harness.mjs's spies) stands in
// front of every command the script and lib.sh start by name; PATH holds nothing else, so none starts unseen. Each keeps
// its environment and its arguments, and both are checked: the URL reaches the node that drops the schema alone, as
// DATABASE_URL. The caller's other URL is made up (a .invalid host never resolves, RFC 6761).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createThrowawayDatabase } from "./release-harness.mjs";
import {
  REPO,
  cleanEnv,
  copyScript,
  namedIn,
  program,
  spies,
  tempDir,
  whereHeld,
  write,
} from "./script-harness.mjs";

const OTHER_URL =
  "postgres://t1343_other_login:t1343-made-up-password@db-t1343-other.example.invalid:5432/t1343_other";
const OTHER_PARTS = ["t1343_other_login", "t1343-made-up-password", "db-t1343-other.example.invalid"];
const CALLER_TEXT = "t1343 made-up caller text";
const BRANCH = "task/T-1343-Cleanup";
const SCHEMA = "preview_task_t_1343_cleanup";
// Every command preview-cleanup.sh and lib.sh start by name (branch_slug's tr and sed among them), but node (below).
const COMMANDS = ["basename", "bash", "date", "dirname", "sed", "tr"];

/** What a recorded command is: the node that drops the schema, or its name. */
const kindOf = (child) =>
  child.name === "node" && child.args.includes("--input-type=module") ? "drop schema" : child.name;

describe("preview-cleanup.sh hands the staging database's URL to the node that drops the schema alone (T-1343)", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let watched;

  before(async () => {
    db = await createThrowawayDatabase("cleanup_urls");
    watched = [db.url, new URL(db.url).pathname.slice(1)];
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  /** A throwaway checkout (with a made-up .dev.vars when devVars is given) whose every command is spied. */
  const spiedRoot = (devVars) => {
    const dir = tempDir(t, "cleanup");
    const root = path.join(dir, "rosie");
    for (const script of ["preview-cleanup.sh", "lib.sh"]) copyScript(script, root);
    mkdirSync(path.join(root, "node_modules"));
    symlinkSync(path.join(REPO, "node_modules", "postgres"), path.join(root, "node_modules", "postgres"));
    if (devVars !== undefined) write(path.join(root, ".dev.vars"), devVars);
    const home = path.join(dir, "home");
    write(path.join(home, ".keep"), "");
    const spy = spies(dir, COMMANDS, { node: [process.execPath] });
    return {
      /** Runs preview-cleanup.sh on BRANCH under the real bash, `bash` holding its options, with the variables given. */
      cleanup({ extra = {}, bash = [] } = {}) {
        spy.clear();
        const result = spawnSync(
          program("bash"),
          [...bash, path.join(root, "infra", "scripts", "preview-cleanup.sh"), BRANCH],
          { cwd: root, encoding: "utf8", env: cleanEnv(home, { PATH: spy.bin, ...extra }) },
        );
        return { ...result, output: `${result.stdout}${result.stderr}`, children: spy.children() };
      },
    };
  };

  /** Whether the branch's preview schema is on the database. */
  const schemaThere = async () =>
    (await db.sql`select 1 from information_schema.schemata where schema_name = ${SCHEMA}`).length === 1;

  /**
   * Makes the branch's preview schema, runs the cleanup, and fails unless it passed and dropped the schema, the node that
   * drops it alone holds the URL, as DATABASE_URL, no command holds it in an argument, no other command has a database
   * URL's name in its environment, none holds the caller's other URL or one of `others`, and the output holds none.
   */
  async function assertDroppedWithUrlAlone(rig, what, run, others = []) {
    await db.sql`create schema if not exists ${db.sql(SCHEMA)}`;
    const result = rig.cleanup(run);
    assert.equal(result.status, 0, `${what}: ${result.output}`);
    assert.match(result.stdout, new RegExp(`cleanup: schema ${SCHEMA} removed`), what);
    assert.equal(await schemaThere(), false, `${what}: the schema is still there`);
    const kinds = new Set(result.children.map(kindOf));
    for (const kind of ["dirname", "date", "tr", "sed", "drop schema"]) {
      assert.ok(kinds.has(kind), `${what}: no ${kind} was recorded`);
    }
    assert.deepEqual(
      whereHeld(result.children, watched, kindOf),
      ["drop schema: env DATABASE_URL"],
      `${what}: the URL`,
    );
    assert.deepEqual(
      namedIn(result.children, ["STAGING_DATABASE_URL", "DATABASE_URL"], kindOf),
      ["drop schema: DATABASE_URL"],
      `${what}: a database URL's name`,
    );
    const [drop] = result.children.filter((child) => kindOf(child) === "drop schema");
    assert.ok(drop.env.split("\n").includes(`DATABASE_URL=${db.url}`), `${what}: the drop's DATABASE_URL`);
    assert.ok(drop.env.split("\n").includes(`PREVIEW_SCHEMA=${SCHEMA}`), `${what}: the drop's schema`);
    assert.deepEqual(
      whereHeld(result.children, [...OTHER_PARTS, ...others], kindOf),
      [],
      `${what}: another text`,
    );
    for (const text of [...watched, ...OTHER_PARTS, ...others]) {
      assert.equal(result.output.includes(text), false, `${what}: the output holds a value`);
    }
    return result;
  }

  it("from the caller's environment beside a DATABASE_URL of another database, or from .dev.vars: the schema is dropped, and its node alone gets the URL", async () => {
    await assertDroppedWithUrlAlone(spiedRoot(), "from the environment", {
      extra: { STAGING_DATABASE_URL: db.url, DATABASE_URL: OTHER_URL },
    });
    for (const line of [`STAGING_DATABASE_URL=${db.url}`, `  export STAGING_DATABASE_URL="${db.url}"`]) {
      await assertDroppedWithUrlAlone(spiedRoot(`# made up\n${line}\n`), "from .dev.vars", {
        extra: { DATABASE_URL: OTHER_URL },
      });
    }
  });

  it("allexport, keyword and tracing from the caller, and the caller's variable of the script's own name, from either source: its node alone", async () => {
    for (const [source, rig, extra] of [
      ["from the environment", spiedRoot(), { STAGING_DATABASE_URL: db.url, DATABASE_URL: OTHER_URL }],
      ["from .dev.vars", spiedRoot(`STAGING_DATABASE_URL=${db.url}\n`), { DATABASE_URL: OTHER_URL }],
    ]) {
      // [mode, its variables, bash's options, what standard error holds: a trace begins and ends at set +x]
      for (const [mode, variables, bash, stderr] of [
        ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, [], ""],
        ["bash -a -k", {}, ["-a", "-k"], ""],
        ["SHELLOPTS=allexport:keyword", { SHELLOPTS: "allexport:keyword" }, [], ""],
        [
          "the caller's database_url under allexport",
          { database_url: CALLER_TEXT, SHELLOPTS: "allexport" },
          [],
          "",
        ],
        ["bash -x", {}, ["-x"], "+ set +x\n"],
        ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, [], "+ set +x\n"],
      ]) {
        const what = `${mode}, ${source}`;
        const result = await assertDroppedWithUrlAlone(
          rig,
          what,
          { extra: { ...extra, ...variables }, bash },
          [CALLER_TEXT],
        );
        assert.equal(result.stderr, stderr, `${what}: standard error`);
      }
    }
  });

  it("with no staging URL, a DATABASE_URL of the caller's reaches no command, and the schema is left in place", async () => {
    await db.sql`create schema if not exists ${db.sql(SCHEMA)}`;
    const result = spiedRoot().cleanup({ extra: { DATABASE_URL: OTHER_URL } });
    assert.equal(result.status, 0, result.output);
    assert.match(
      result.stdout,
      new RegExp(`cleanup: NOTICE: STAGING_DATABASE_URL is not set, so schema ${SCHEMA} was left in place`),
    );
    assert.equal(await schemaThere(), true);
    assert.equal(result.children.filter((child) => child.name === "node").length, 0, "node was started");
    assert.deepEqual(whereHeld(result.children, OTHER_PARTS, kindOf), []);
    assert.deepEqual(namedIn(result.children, ["STAGING_DATABASE_URL", "DATABASE_URL"], kindOf), []);
    await db.sql`drop schema ${db.sql(SCHEMA)}`;
  });

  it("a recorder keeps a command's environment and arguments, and the checks find a URL in either (the control for the checks above)", (t) => {
    const dir = tempDir(t, "cleanup-spy-control");
    const spy = spies(dir, ["tr"]);
    spawnSync(path.join(spy.bin, "tr"), ["a-z", OTHER_URL], {
      env: { PATH: spy.bin, DATABASE_URL: OTHER_URL },
      encoding: "utf8",
      input: "",
    });
    const children = spy.children();
    assert.deepEqual(whereHeld(children, OTHER_PARTS, kindOf), ["tr: env DATABASE_URL, args 1"]);
    assert.deepEqual(namedIn(children, ["STAGING_DATABASE_URL", "DATABASE_URL"], kindOf), [
      "tr: DATABASE_URL",
    ]);
  });
});
