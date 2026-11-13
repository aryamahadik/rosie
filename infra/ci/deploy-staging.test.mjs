// Tests for infra/scripts/deploy-staging.sh's steps 3 and 4 and their undo (T-569; build prompt 5.4: "3. for a bundle,
// publish it, then switch the active bundle id; 4. the flags the approved cards name"; "If a step fails: stop; undo
// what can be undone (flag off, previous bundle id, previous code)"), run by `node --test "infra/ci/*.test.mjs"`.
// The deploy runs in a throwaway checkout (release-harness.mjs): wrangler is a fake that records each call (staging's
// live version never changes, so the code's rollback has nothing to roll back), curl is a fake health check, and the
// staging database is a throwaway local one, migrated as the staging database is. The last describe holds T-1304's
// tests of Rosie's own number, ROSIE_NUMBER, which step 2 gives the Worker by name; those deploys need no database.
// The last describe (T-1343) puts a recorder in front of every command the deploy starts, and shows which of them get
// the staging database's URL and the number.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  V0_ID,
  V0_KEYS,
  assertNoUrlPart,
  badUrlRunners,
  createThrowawayDatabase,
  readActive,
  releaseRoot,
  v0WithBuild,
} from "./release-harness.mjs";
import { cleanEnv, namedIn, program, spies, tempDir, whereHeld } from "./script-harness.mjs";

const SHA = "5690000000000000000000000000000000000569";
const LIVE = "00000000-0000-4000-8000-000000000569";
/** The deploy's variables: the commit, the fake wrangler's live version, the fake check's answer, the base URL. */
const DEPLOY_ENV = {
  GIT_SHA: SHA,
  FAKE_VERSION: SHA,
  FAKE_LIVE_VERSION: LIVE,
  STAGING_BASE_URL: "https://rosie-staging.example.invalid/test",
  CHECK_ATTEMPTS: "1",
};

describe("deploy-staging.sh: steps 3 and 4", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;
  let build2;

  before(async () => {
    db = await createThrowawayDatabase("deploy");
    rig = releaseRoot(t);
    build2 = v0WithBuild(t, 2);
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  const deploy = (args, extra = {}) => rig.run("deploy-staging.sh", args, { ...DEPLOY_ENV, ...extra });
  const skeleton = async () => {
    const [row] =
      await db.sql`select enabled from release_flags where name = 'skeleton' and scope = 'global'`;
    return row === undefined ? "no row" : row.enabled ? "on" : "off";
  };
  /** The lines of the deploy's log that name a step, an undo or the rollback, without their times. */
  const steps = (stdout) =>
    stdout
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]+\] /, ""))
      .filter((line) => /^(step \d\/4|undo:|rollback:|check:|deploy-staging:)/.test(line));
  const kvPuts = (calls) => calls.filter((call) => call.tool === "kv");

  it("without STAGING_DATABASE_URL: steps 1, 3 and 4 are skipped with a notice; the code and the check run", () => {
    const result = deploy([]);
    assert.equal(result.status, 0, result.output);
    const lines = steps(result.stdout);
    assert.ok(
      lines.includes("step 1/4 migrate: skipped (NOTICE: STAGING_DATABASE_URL is not set)"),
      result.stdout,
    );
    assert.ok(
      lines.some((line) => line.startsWith("step 3/4 bundle: skipped (NOTICE: STAGING_DATABASE_URL")),
    );
    assert.ok(lines.some((line) => line.startsWith("step 4/4 flags: skipped (NOTICE: STAGING_DATABASE_URL")));
    assert.ok(
      lines.includes(`deploy-staging: done, version ${LIVE} at https://rosie-staging.example.invalid/test`),
    );
    assert.deepEqual(kvPuts(rig.calls()), []);
  });

  it("with the staging database: bundles/v0 is published and made active, then the staging flag set is applied", async () => {
    const callsBefore = rig.calls().length;
    const result = deploy([], { STAGING_DATABASE_URL: db.url });
    assert.equal(result.status, 0, result.output);
    const lines = steps(result.stdout);
    const order = [
      "step 1/4 migrate: done",
      "step 2/4 code: done",
      "step 3/4 bundle: publish",
      "step 3/4 bundle: done",
      "step 4/4 flags: the staging flag set",
      "step 4/4 flags: done",
      "check: start",
      "deploy-staging: done",
    ].map((start) => lines.findIndex((line) => line.startsWith(start)));
    assert.ok(
      order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])),
      lines.join("\n"),
    );
    assert.match(result.stdout, new RegExp(`active bundle id: none -> ${V0_ID} \\(K-05 setActiveBundle\\)`));
    assert.match(result.stdout, /flags: skeleton: on \(a new global row, version 1\)/);
    assert.equal(await readActive(db.sql), V0_ID);
    assert.equal(await skeleton(), "on");
    const puts = kvPuts(rig.calls().slice(callsBefore));
    assert.deepEqual(
      puts.map((put) => put.entries.map((entry) => entry.key)),
      [V0_KEYS],
    );
  });

  it("a failed check undoes steps 4 and 3: the flag goes off again and the bundle id goes back", async () => {
    // Before this deploy: bundle v0 build 2 is active and the skeleton flag is off.
    const switched = rig.run("publish-bundle.sh", [build2.dir], { STAGING_DATABASE_URL: db.url });
    assert.equal(switched.status, 0, switched.output);
    const off = rig.run("flags.sh", ["off", "skeleton"], { STAGING_DATABASE_URL: db.url });
    assert.equal(off.status, 0, off.output);
    assert.equal(await readActive(db.sql), build2.id);
    assert.equal(await skeleton(), "off");

    const result = deploy([], { STAGING_DATABASE_URL: db.url, FAKE_CURL_MODE: "fail" });
    assert.equal(result.status, 1, result.output);
    const lines = steps(result.stdout);
    const order = [
      "step 3/4 bundle: done",
      "step 4/4 flags: done",
      "check: FAILED",
      "deploy-staging: FAILED (exit 1) after step 2 started",
      "undo: flag skeleton off again (step 4 turned it on)",
      `undo: the active bundle id goes back to ${build2.id} (step 3 switched it to ${V0_ID})`,
      `rollback: nothing to roll back, staging still runs ${LIVE}`,
    ].map((start) => lines.findIndex((line) => line.startsWith(start)));
    assert.ok(
      order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])),
      lines.join("\n"),
    );
    assert.equal(await readActive(db.sql), build2.id);
    assert.equal(await skeleton(), "off");
  });

  it("a failed step 3 changes no flag and no bundle id, and goes on to the code's rollback", async () => {
    assert.equal(await readActive(db.sql), build2.id);
    assert.equal(await skeleton(), "off");
    const result = deploy([], { STAGING_DATABASE_URL: db.url, FAKE_KV: "fail" });
    assert.equal(result.status, 1, result.output);
    const lines = steps(result.stdout);
    assert.ok(
      lines.some((line) => line.startsWith("step 3/4 bundle: publish")),
      lines.join("\n"),
    );
    assert.ok(!lines.some((line) => line.startsWith("step 3/4 bundle: done")), lines.join("\n"));
    assert.ok(!lines.some((line) => line.startsWith("step 4/4")), lines.join("\n"));
    assert.ok(!lines.some((line) => line.startsWith("undo:")), lines.join("\n"));
    assert.ok(
      lines.includes(
        `rollback: nothing to roll back, staging still runs ${LIVE} (the version before this deploy)`,
      ),
    );
    assert.equal(await readActive(db.sql), build2.id);
    assert.equal(await skeleton(), "off");
  });

  it("--bundle names the bundle folder to publish", async () => {
    const result = deploy(["--bundle", build2.dir], { STAGING_DATABASE_URL: db.url });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, new RegExp(`active bundle id: ${build2.id}, already active`));
    assert.equal(await readActive(db.sql), build2.id);
    assert.equal(await skeleton(), "on");
  });

  it("refuses --env production (and any --env) before anything runs", () => {
    const callsBefore = rig.calls().length;
    for (const args of [["--env", "production"], ["--env=production"], ["--env", "staging"]]) {
      const result = deploy(args, { STAGING_DATABASE_URL: db.url });
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.output}`);
      assert.match(result.stderr, /refused: deploy-staging\.sh deploys staging only and takes no --env/);
      assert.match(result.stderr, /protected release job/);
      assert.equal(result.stdout, "", args.join(" "));
    }
    assert.equal(rig.calls().length, callsBefore);
  });

  it("refuses a --bundle folder that holds no bundle, before deploying anything", () => {
    const callsBefore = rig.calls().length;
    const result = deploy(["--bundle", path.join(rig.dir, "home")], { STAGING_DATABASE_URL: db.url });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      /holds no bundle \(no manifest\.json in it or in its bundle\/ folder\): nothing was deployed/,
    );
    assert.equal(rig.calls().length, callsBefore);
  });

  it("a staging database URL that does not parse, or a staging database that does not answer, stops the deploy at step 1: no part of it printed, nothing deployed or written", async () => {
    const active = await readActive(db.sql);
    const flag = await skeleton();
    const names = ["hash", "hashAfterDigits", "comment", "refused", "notFound"];
    for (const runner of badUrlRunners(t, rig, names)) {
      const what = runner.bad.name;
      const callsBefore = runner.calls().length;
      const result = runner.run("deploy-staging.sh", [], { ...DEPLOY_ENV, DATABASE_URL: db.url });
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      const lines = steps(result.stdout);
      assert.ok(lines.includes("step 1/4 migrate: start"), `${what}: ${lines.join("\n")}`);
      assert.ok(
        !lines.some((line) => /^step (1\/4 migrate: done|[234]\/4)/.test(line)),
        `${what}: ${lines.join("\n")}`,
      );
      assertNoUrlPart(result, runner.bad, what);
      assert.equal(runner.calls().length, callsBefore, `${what}: nothing was deployed (wrangler never ran)`);
      assert.equal(await readActive(db.sql), active, what);
      assert.equal(await skeleton(), flag, what);
    }
  });
});

// Rosie's own number (T-1304; CQ-253 as DL-542 refines it; K-05 default 109 and open gap 63): ROSIE_NUMBER reaches
// the staging Worker only as step 2's --var ROSIE_NUMBER:<number>, read by name from the environment, else from the
// checkout's .dev.vars. These deploys run without STAGING_DATABASE_URL (steps 1, 3 and 4 are skipped), so they need
// no database. Every number is a fiction-range one (+1 555 555-01xx), and no deploy's output may hold it. The wrangler
// and curl stand-ins also note when ROSIE_NUMBER is in their environment, which the script empties before any command
// of the deploy runs, so only the deploy's arguments carry it. DL-581 adds two: cleanEnv drops this shell's
// ROSIE_NUMBER, and no trace a caller turns on prints the number.
describe("deploy-staging.sh: Rosie's own number, ROSIE_NUMBER (T-1304)", () => {
  const NUMBER = "+15555550142";
  const GIVEN =
    "step 2/4 code: ROSIE_NUMBER goes to the Worker by name, as a var (wrangler prints its value as (hidden))";
  const MISSING =
    "step 2/4 code: NOTICE: ROSIE_NUMBER is not set, so the Worker gets no number and chat links stay off " +
    "(K-05 default 109)";
  const MALFORMED =
    "step 2/4 code: NOTICE: ROSIE_NUMBER is not in E.164 form (a + and 7 to 15 digits), so the Worker gets no " +
    "number and chat links stay off (K-05 default 109); the value is not printed";

  /**
   * A release root (with a made-up .dev.vars when devVars is given) whose wrangler and curl stand-ins first write their
   * name to a note when ROSIE_NUMBER is in their environment. deploy(extra) runs deploy-staging.sh with DEPLOY_ENV and
   * extra, and gives that run's own calls; noted() lists the stand-ins that found ROSIE_NUMBER.
   */
  const rigOf = (t, devVars) => {
    const rig = releaseRoot(t, devVars === undefined ? {} : { devVars });
    const note = path.join(rig.dir, "rosie-number-environment.txt");
    const standIns = [
      path.join(rig.root, "node_modules", ".bin", "wrangler"),
      path.join(rig.dir, "bin", "curl"),
    ];
    for (const file of standIns) {
      const [shebang, ...rest] = readFileSync(file, "utf8").split("\n");
      const check = `if [[ -n "\${ROSIE_NUMBER+set}" ]]; then echo ${path.basename(file)} >>"${note}"; fi`;
      writeFileSync(file, [shebang, check, ...rest].join("\n"));
    }
    return {
      ...rig,
      standIns,
      deploy(extra) {
        const from = rig.calls().length;
        const result = rig.run("deploy-staging.sh", [], { ...DEPLOY_ENV, ...extra });
        return { ...result, calls: rig.calls().slice(from) };
      },
      noted() {
        if (!existsSync(note)) return [];
        return readFileSync(note, "utf8")
          .split("\n")
          .filter((line) => line !== "");
      },
    };
  };
  /** The --var values of the one wrangler deploy among the calls. */
  const deployVars = (calls) => {
    const deploys = calls.filter((call) => call.tool === "wrangler" && call.args.includes("deploy"));
    assert.equal(deploys.length, 1, JSON.stringify(deploys));
    const { args } = deploys[0];
    return args.filter((_, at) => args[at - 1] === "--var");
  };
  /** The lines of the deploy's log that name ROSIE_NUMBER, without their times. */
  const numberLines = (stdout) =>
    stdout
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]+\] /, ""))
      .filter((line) => line.includes("ROSIE_NUMBER"));
  /** Fails when a run's output holds the value as given, trimmed, or as its digits alone. */
  const assertNotPrinted = (result, value, what) => {
    for (const piece of new Set([value, value.trim(), value.replace(/[^0-9]/g, "")])) {
      assert.ok(piece === "" || !result.output.includes(piece), `${what}: the output holds the value`);
    }
  };

  it("from the environment: only the deploy gets it, as --var ROSIE_NUMBER:<number>; no output or environment holds it", (t) => {
    const rig = rigOf(t);
    const result = rig.deploy({ ROSIE_NUMBER: NUMBER });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(deployVars(result.calls), [`GIT_SHA:${SHA}`, `ROSIE_NUMBER:${NUMBER}`]);
    const holding = result.calls.filter((call) => JSON.stringify(call).includes(NUMBER));
    assert.equal(holding.length, 1, "no call but the deploy holds the number");
    assert.deepEqual(numberLines(result.stdout), [GIVEN]);
    assert.match(result.stdout, /deploy-staging: done/);
    assertNotPrinted(result, NUMBER, "from the environment");
    assert.deepEqual(rig.noted(), []);
  });

  it("from .dev.vars when the environment has none or an empty one: read by name, bare, quoted or exported", (t) => {
    for (const line of [
      `ROSIE_NUMBER=${NUMBER}`,
      `ROSIE_NUMBER="${NUMBER}"`,
      `export ROSIE_NUMBER='${NUMBER}'`,
    ]) {
      const rig = rigOf(t, `OTHER=1\n${line}\n`);
      for (const value of [undefined, ""]) {
        const what = `${line} with ${JSON.stringify(value)} in the environment`;
        const result = rig.deploy({ ROSIE_NUMBER: value });
        assert.equal(result.status, 0, `${what}: ${result.output}`);
        assert.deepEqual(deployVars(result.calls), [`GIT_SHA:${SHA}`, `ROSIE_NUMBER:${NUMBER}`], what);
        assert.deepEqual(numberLines(result.stdout), [GIVEN], what);
        assertNotPrinted(result, NUMBER, what);
      }
      assert.deepEqual(rig.noted(), [], line);
    }
  });

  it("the environment's value wins over .dev.vars'", (t) => {
    const rig = rigOf(t, "ROSIE_NUMBER=+15555550143\n");
    const result = rig.deploy({ ROSIE_NUMBER: NUMBER });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(deployVars(result.calls), [`GIT_SHA:${SHA}`, `ROSIE_NUMBER:${NUMBER}`]);
    assertNotPrinted(result, "+15555550143", "the number in .dev.vars");
  });

  it("missing: the deploy goes on without it, and one line says chat links stay off", (t) => {
    for (const [what, devVars, value] of [
      ["unset, with no .dev.vars", undefined, undefined],
      ["empty, with no .dev.vars", undefined, ""],
      ["unset, with a .dev.vars that has none", "OTHER=1\n", undefined],
      ["unset, with an empty line in .dev.vars", "ROSIE_NUMBER=\n", undefined],
    ]) {
      const rig = rigOf(t, devVars);
      const result = rig.deploy({ ROSIE_NUMBER: value });
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.deepEqual(deployVars(result.calls), [`GIT_SHA:${SHA}`], what);
      assert.deepEqual(numberLines(result.stdout), [MISSING], what);
      assert.match(result.stdout, /deploy-staging: done/, what);
    }
  });

  it("malformed: the deploy goes on without it, one line says chat links stay off, and the value is never printed", (t) => {
    const rig = rigOf(t);
    for (const value of [
      "5555550142",
      "15555550142",
      "555-555-0142",
      "(555) 555-0142",
      "+1 555 555 0142",
      "+1-555-555-0142",
      ` ${NUMBER}`,
      `${NUMBER} `,
      `${NUMBER}\n`,
      "+05555550142",
      "+155555",
      `${NUMBER}01420`,
      `tel:${NUMBER}`,
      `${NUMBER},GIT_SHA:0`,
    ]) {
      const what = JSON.stringify(value);
      const result = rig.deploy({ ROSIE_NUMBER: value });
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.deepEqual(deployVars(result.calls), [`GIT_SHA:${SHA}`], what);
      assert.deepEqual(numberLines(result.stdout), [MALFORMED], what);
      assert.match(result.stdout, /deploy-staging: done/, what);
      assertNotPrinted(result, value, what);
    }
    // A .dev.vars line with a comment after the number: load_dev_var keeps the comment in the value.
    const commented = rigOf(t, `ROSIE_NUMBER=${NUMBER} # Rosie's line\n`);
    const result = commented.deploy({ ROSIE_NUMBER: undefined });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(deployVars(result.calls), [`GIT_SHA:${SHA}`]);
    assert.deepEqual(numberLines(result.stdout), [MALFORMED]);
    assertNotPrinted(result, `${NUMBER} # Rosie's line`, "a commented .dev.vars line");
    assert.deepEqual([...rig.noted(), ...commented.noted()], []);
  });

  it("cleanEnv drops ROSIE_NUMBER: a deploy test that gives no number of its own never takes this shell's (DL-581)", (t) => {
    // This process's own value, if any, is kept aside and put back unread: it may be Rosie's real number.
    const had = Object.hasOwn(process.env, "ROSIE_NUMBER");
    const kept = process.env.ROSIE_NUMBER;
    process.env.ROSIE_NUMBER = NUMBER;
    try {
      const rig = rigOf(t);
      const home = path.join(rig.dir, "home");
      assert.equal(Object.hasOwn(cleanEnv(home), "ROSIE_NUMBER"), false, "cleanEnv kept ROSIE_NUMBER");
      assert.equal(
        cleanEnv(home, { ROSIE_NUMBER: NUMBER }).ROSIE_NUMBER,
        NUMBER,
        "a test still gives one by name",
      );
      const result = rig.deploy({});
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(deployVars(result.calls), [`GIT_SHA:${SHA}`], "the deploy took this shell's number");
      assert.deepEqual(numberLines(result.stdout), [MISSING]);
      assert.deepEqual(rig.noted(), []);
    } finally {
      if (had) process.env.ROSIE_NUMBER = kept;
      else delete process.env.ROSIE_NUMBER;
    }
  });

  it("tracing from the caller (bash -x, xtrace handed down in SHELLOPTS, or a BASH_ENV that turns it on) never prints the number: the script switches it off first (DL-581)", (t) => {
    // The stand-ins are bash scripts, as the real wrangler and curl are not: under BASH_ENV each would trace its own exec
    // line, the deploy's arguments with it. So here they switch tracing off first, and only what the scripts under test
    // (deploy-staging.sh, cf.sh, post-deploy-check.sh) trace reaches the output.
    const quiet = (rig) => {
      for (const file of rig.standIns) {
        const [shebang, ...rest] = readFileSync(file, "utf8").split("\n");
        writeFileSync(file, [shebang, "set +x", ...rest].join("\n"));
      }
      // bash -x for the script alone: rig.deploy starts bash on a script, so this one starts the deploy under -x.
      writeFileSync(
        path.join(rig.root, "infra", "scripts", "traced-deploy.sh"),
        '#!/usr/bin/env bash\nexec bash -x "$(dirname "${BASH_SOURCE[0]}")/deploy-staging.sh" "$@"\n',
      );
      const traceOn = path.join(rig.dir, "trace-on.sh");
      writeFileSync(traceOn, "set -x\n");
      return traceOn;
    };
    // [title, a .dev.vars text (undefined: none), the variables, whether the deploy starts under bash -x]
    const cases = [
      ["bash -x", undefined, { ROSIE_NUMBER: NUMBER }, true],
      ["SHELLOPTS=xtrace", undefined, { ROSIE_NUMBER: NUMBER, SHELLOPTS: "xtrace" }, false],
      ["BASH_ENV turning tracing on", undefined, { ROSIE_NUMBER: NUMBER }, false],
      [
        "SHELLOPTS=xtrace, the number from .dev.vars",
        `ROSIE_NUMBER=${NUMBER}\n`,
        { SHELLOPTS: "xtrace" },
        false,
      ],
      ["bash -x, the number from .dev.vars", `export ROSIE_NUMBER='${NUMBER}'\n`, {}, true],
    ];
    for (const [what, devVars, extra, traced] of cases) {
      const rig = rigOf(t, devVars);
      const traceOn = quiet(rig);
      const variables = what.startsWith("BASH_ENV") ? { ...extra, BASH_ENV: traceOn } : extra;
      const from = rig.calls().length;
      const result = rig.run(traced ? "traced-deploy.sh" : "deploy-staging.sh", [], {
        ...DEPLOY_ENV,
        ...variables,
      });
      const calls = rig.calls().slice(from);
      assert.equal(result.status, 0, `${what}: exit ${String(result.status)}`);
      assert.deepEqual(deployVars(calls), [`GIT_SHA:${SHA}`, `ROSIE_NUMBER:${NUMBER}`], what);
      assert.deepEqual(numberLines(result.stdout), [GIVEN], what);
      assertNotPrinted(result, NUMBER, what);
      assert.ok(
        result.stderr.startsWith("+ set +x\n"),
        `${what}: the trace does not begin at the script's set +x`,
      );
      if (!what.startsWith("BASH_ENV")) {
        // No child traces: bash -x is the script's own, and SHELLOPTS hands down the switch-off.
        assert.equal(result.stderr, "+ set +x\n", `${what}: the trace went on after set +x`);
      }
      assert.deepEqual(rig.noted(), [], what);
    }
  });

  it("a stand-in notes ROSIE_NUMBER when its environment holds it (the control for the checks above)", (t) => {
    const rig = rigOf(t);
    const env = {
      PATH: process.env.PATH,
      FAKE_LOG: path.join(rig.dir, "control.ndjson"),
      ROSIE_NUMBER: NUMBER,
    };
    for (const file of rig.standIns) spawnSync(file, [], { env, encoding: "utf8" });
    assert.deepEqual(rig.noted(), ["wrangler", "curl"]);
  });
});

// T-1343 (T-1310's new tasks b and c, and its security review's): the staging database's URL reaches only the commands
// that use the database, each by name on its own command line: step 1's migrate.mjs (DATABASE_URL), publish-bundle.sh
// and flags.sh (STAGING_DATABASE_URL, at steps 3 and 4 and in the undo), and their own database programs (DATABASE_URL);
// Rosie's own number reaches step 2's deploy alone, in its arguments (cf.sh's and wrangler's --var). A recorder
// (script-harness.mjs's spies) stands in front of every command the deploy and the scripts it runs start by name, and of
// the checkout's wrangler; PATH holds nothing else, so none starts unseen. Each keeps its environment and its arguments,
// and both are checked. The staging database is a throwaway local one; the caller's other URL is made up (a .invalid
// host never resolves, RFC 6761) and the number is in the fiction range.
describe("deploy-staging.sh hands the staging database's URL to the commands that use it, and Rosie's number to the deploy alone (T-1343)", () => {
  const NUMBER = "+15555550142";
  const OTHER_URL =
    "postgres://t1343_other_login:t1343-made-up-password@db-t1343-other.example.invalid:5432/t1343_other";
  const OTHER_PARTS = ["t1343_other_login", "t1343-made-up-password", "db-t1343-other.example.invalid"];
  const CALLER_TEXT = "t1343 made-up caller text";
  // Every command deploy-staging.sh, lib.sh, cf.sh, publish-bundle.sh, flags.sh, post-deploy-check.sh and
  // rollback-staging.sh start by name, but node, curl and sleep (below).
  const COMMANDS = [
    "basename",
    "bash",
    "date",
    "dirname",
    "git",
    "grep",
    "head",
    "mktemp",
    "rm",
    "sed",
    "tr",
  ];
  // The commands that use the database, and the name each gets the URL under.
  const URL_HOLDERS = [
    "flags.mjs: env DATABASE_URL",
    "flags.sh: env STAGING_DATABASE_URL",
    "migrate.mjs: env DATABASE_URL",
    "publish-bundle.sh: env STAGING_DATABASE_URL",
    "registry activate: env DATABASE_URL",
    "registry active: env DATABASE_URL",
    "registry publish: env DATABASE_URL",
  ];
  const named = (lines) => lines.map((line) => line.replace(": env ", ": ")).sort();
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let watched;
  let fromEnv;
  let fromFile;

  /** What a recorded command is: a script by its file (cf.sh and wrangler with their first word), a node program, or its name. */
  const kindOf = (child) => {
    const [first = ""] = child.args;
    if (child.name === "bash") {
      const script = /\/infra\/scripts\/([a-z-]+\.sh)$/.exec(first)?.[1] ?? "bash";
      return script === "cf.sh" ? `cf.sh ${child.args[1] ?? ""}` : script;
    }
    if (child.name === "wrangler") return `wrangler ${child.args[2] ?? ""}`;
    if (child.name !== "node") return child.name;
    if (first === "infra/scripts/migrate.mjs") return "migrate.mjs";
    if (child.args.some((arg) => arg.endsWith("/infra/flags/flags.mjs"))) return "flags.mjs";
    if (child.args.some((arg) => arg.includes("registryCall"))) return `registry ${child.args[6] ?? ""}`;
    return "node";
  };

  /** A release root (with a made-up .dev.vars when devVars is given) whose every command is spied (above). */
  const spiedRig = (devVars) => {
    const rig = releaseRoot(t, devVars === undefined ? {} : { devVars });
    const fake = (name) => path.join(rig.dir, "fake", name);
    const spy = spies(rig.dir, COMMANDS, {
      node: [process.execPath],
      curl: [process.execPath, fake("record.cjs"), "curl"],
      sleep: [process.execPath, fake("record.cjs"), "sleep"],
    });
    spy.put(path.join(rig.root, "node_modules", ".bin", "wrangler"), "wrangler", [
      process.execPath,
      fake("wrangler.cjs"),
    ]);
    return {
      ...rig,
      /** Runs deploy-staging.sh under the real bash, `bash` holding its options, with DEPLOY_ENV and extra. */
      deploy({ extra = {}, bash = [] } = {}) {
        spy.clear();
        const result = spawnSync(
          program("bash"),
          [...bash, path.join(rig.root, "infra", "scripts", "deploy-staging.sh")],
          {
            cwd: rig.root,
            encoding: "utf8",
            env: cleanEnv(path.join(rig.dir, "home"), {
              PATH: spy.bin,
              FAKE_LOG: path.join(rig.dir, "calls.ndjson"),
              DB_SCHEMA: undefined,
              ...DEPLOY_ENV,
              ...extra,
            }),
          },
        );
        return { ...result, output: `${result.stdout}${result.stderr}`, children: spy.children() };
      },
    };
  };

  before(async () => {
    db = await createThrowawayDatabase("deploy_urls");
    watched = [db.url, new URL(db.url).pathname.slice(1)];
    fromEnv = spiedRig();
    fromFile = spiedRig(`# made up\nSTAGING_DATABASE_URL=${db.url}\n  export ROSIE_NUMBER='${NUMBER}'\n`);
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  // [title, the rig, its variables]: the URL and the number from the caller's environment, beside a DATABASE_URL of
  // the caller's that names another database, or from the checkout's .dev.vars.
  const sources = () => [
    [
      "from the environment",
      fromEnv,
      { STAGING_DATABASE_URL: db.url, ROSIE_NUMBER: NUMBER, DATABASE_URL: OTHER_URL },
    ],
    ["from .dev.vars", fromFile, { DATABASE_URL: OTHER_URL }],
  ];

  /**
   * Fails unless the deploy ran every step and the URL reached the commands that use the database alone (`holders`),
   * each by name, the number reached the deploy's arguments alone, no command holds the caller's other URL or one of
   * `others` or has ROSIE_NUMBER in its environment, and the output holds none of them.
   */
  function assertHandedOnAlone(result, what, { holders = URL_HOLDERS, others = [] } = {}) {
    const kinds = new Set(result.children.map(kindOf));
    for (const kind of [
      "dirname",
      "date",
      "mktemp",
      "rm",
      "sed",
      "tr",
      "node",
      "curl",
      "migrate.mjs",
      "cf.sh deployments",
      "wrangler deployments",
      "cf.sh deploy",
      "wrangler deploy",
      "publish-bundle.sh",
      "registry manifest-id",
      "cf.sh kv",
      "wrangler kv",
      "flags.sh",
      "flags.mjs",
      "post-deploy-check.sh",
    ]) {
      assert.ok(kinds.has(kind), `${what}: no ${kind} was recorded`);
    }
    assert.deepEqual(
      whereHeld(result.children, watched, kindOf),
      [...holders].sort(),
      `${what}: where the URL is`,
    );
    assert.deepEqual(
      namedIn(result.children, ["STAGING_DATABASE_URL", "DATABASE_URL"], kindOf),
      named(holders),
      `${what}: which commands have a database URL's name in their environment`,
    );
    for (const child of result.children) {
      const name = /: env (\S+)$/.exec(
        holders.find((line) => line.startsWith(`${kindOf(child)}: `)) ?? "",
      )?.[1];
      if (name !== undefined) {
        assert.ok(child.env.split("\n").includes(`${name}=${db.url}`), `${what}: ${kindOf(child)}'s ${name}`);
      }
    }
    assert.deepEqual(
      whereHeld(result.children, [NUMBER, NUMBER.slice(1)], kindOf),
      ["cf.sh deploy: args 1", "wrangler deploy: args 1"],
      `${what}: where the number is`,
    );
    const [deploy] = result.children.filter((child) => kindOf(child) === "wrangler deploy");
    assert.deepEqual(
      deploy.args.filter((_, at) => deploy.args[at - 1] === "--var"),
      [`GIT_SHA:${SHA}`, `ROSIE_NUMBER:${NUMBER}`],
      `${what}: the deploy's vars`,
    );
    assert.deepEqual(namedIn(result.children, ["ROSIE_NUMBER"], kindOf), [], `${what}: ROSIE_NUMBER's name`);
    assert.deepEqual(
      whereHeld(result.children, [...OTHER_PARTS, ...others], kindOf),
      [],
      `${what}: a command holds the caller's other URL or text`,
    );
    for (const text of [...watched, ...OTHER_PARTS, ...others, NUMBER, NUMBER.slice(1)]) {
      assert.equal(result.output.includes(text), false, `${what}: the output holds a value`);
    }
  }

  /** The deploy's step lines, without their times. */
  const stepLines = (stdout) =>
    stdout
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]+\] /, ""))
      .filter((line) => /^(step \d\/4|undo:|rollback:|check:|deploy-staging:)/.test(line));

  it("from the caller's environment, or from .dev.vars: each command that uses the database gets the URL by name, the deploy alone gets the number, and no other command gets either", () => {
    for (const [what, rig, extra] of sources()) {
      const result = rig.deploy({ extra });
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      const lines = stepLines(result.stdout);
      for (const step of ["step 1/4 migrate: done", "step 3/4 bundle: done", "step 4/4 flags: done"]) {
        assert.ok(lines.includes(step), `${what}: ${lines.join("\n")}`);
      }
      assert.ok(
        lines.includes(
          "step 2/4 code: ROSIE_NUMBER goes to the Worker by name, as a var (wrangler prints its value as (hidden))",
        ),
        what,
      );
      assert.ok(
        lines.includes(`deploy-staging: done, version ${LIVE} at ${DEPLOY_ENV.STAGING_BASE_URL}`),
        what,
      );
      assertHandedOnAlone(result, what);
    }
  });

  it("allexport and keyword from the caller, from either source: still each command that uses the database alone, and the deploy alone", () => {
    for (const [source, rig, extra] of sources()) {
      for (const [mode, variables, bash] of [
        ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, []],
        ["bash -a -k", {}, ["-a", "-k"]],
        ["SHELLOPTS=allexport:keyword", { SHELLOPTS: "allexport:keyword" }, []],
      ]) {
        const what = `${mode}, ${source}`;
        const result = rig.deploy({ extra: { ...extra, ...variables }, bash });
        assert.equal(result.status, 0, `${what}: ${result.output}`);
        assertHandedOnAlone(result, what);
      }
    }
  });

  it("the caller's variables of the script's own names (database_url, rosie_number, rosie_number_var) hand nothing on, with allexport or without", () => {
    const caller = { database_url: CALLER_TEXT, rosie_number: CALLER_TEXT, rosie_number_var: CALLER_TEXT };
    for (const [what, variables] of [
      ["the caller's variables", caller],
      ["the caller's variables under allexport", { ...caller, SHELLOPTS: "allexport" }],
    ]) {
      const result = fromEnv.deploy({
        extra: { STAGING_DATABASE_URL: db.url, ROSIE_NUMBER: NUMBER, ...variables },
      });
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assertHandedOnAlone(result, what, { others: [CALLER_TEXT] });
    }
  });

  it("tracing from the caller (bash -x, or handed down in SHELLOPTS), from either source, prints neither: the script switches it off first", () => {
    for (const [source, rig, extra] of sources()) {
      for (const [mode, variables, bash] of [
        ["bash -x", {}, ["-x"]],
        ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, []],
      ]) {
        const what = `${mode}, ${source}`;
        const result = rig.deploy({ extra: { ...extra, ...variables }, bash });
        assert.equal(result.status, 0, `${what}: exit ${String(result.status)}`);
        assertHandedOnAlone(result, what);
        assert.equal(result.stderr, "+ set +x\n", `${what}: the trace went on after set +x`);
      }
    }
  });

  it("a failed check: the undo's flags.sh and publish-bundle.sh get the URL by name too, and nothing else does", async () => {
    // Before this deploy: bundle v0 build 2 is active and the skeleton flag is off (unspied runs).
    const build2 = v0WithBuild(t, 2);
    const switched = fromEnv.run("publish-bundle.sh", [build2.dir], { STAGING_DATABASE_URL: db.url });
    assert.equal(switched.status, 0, switched.output);
    const off = fromEnv.run("flags.sh", ["off", "skeleton"], { STAGING_DATABASE_URL: db.url });
    assert.equal(off.status, 0, off.output);
    const result = fromEnv.deploy({
      extra: { STAGING_DATABASE_URL: db.url, ROSIE_NUMBER: NUMBER, FAKE_CURL_MODE: "fail" },
    });
    assert.equal(result.status, 1, result.output);
    const lines = stepLines(result.stdout);
    assert.ok(lines.includes("undo: flag skeleton off again (step 4 turned it on)"), lines.join("\n"));
    assert.ok(
      lines.includes(`undo: the active bundle id goes back to ${build2.id} (step 3 switched it to ${V0_ID})`),
      lines.join("\n"),
    );
    assert.equal(await readActive(db.sql), build2.id);
    // Steps 1, 3 and 4, then the undo: flags.sh off (and its flags.mjs), then publish-bundle.sh --activate (and its
    // registry's active and activate).
    assertHandedOnAlone(result, "a failed check", {
      holders: [
        ...URL_HOLDERS,
        "flags.sh: env STAGING_DATABASE_URL",
        "flags.mjs: env DATABASE_URL",
        "publish-bundle.sh: env STAGING_DATABASE_URL",
        "registry active: env DATABASE_URL",
        "registry activate: env DATABASE_URL",
      ],
    });
  });

  it("a recorder keeps a command's environment and arguments, and the checks find a value in either (the control for the checks above)", (t) => {
    const dir = tempDir(t, "deploy-spy-control");
    const spy = spies(dir, ["date"]);
    const args = ["-u", `--var=ROSIE_NUMBER:${NUMBER}`, "two\nlines"];
    spawnSync(path.join(spy.bin, "date"), args, {
      env: { PATH: spy.bin, STAGING_DATABASE_URL: OTHER_URL },
      encoding: "utf8",
    });
    const children = spy.children();
    const name = (child) => child.name;
    assert.deepEqual(
      children.map((child) => child.args),
      [args],
    );
    assert.deepEqual(whereHeld(children, OTHER_PARTS, name), ["date: env STAGING_DATABASE_URL"]);
    assert.deepEqual(whereHeld(children, [NUMBER], name), ["date: args 1"]);
    assert.deepEqual(namedIn(children, ["STAGING_DATABASE_URL", "ROSIE_NUMBER"], name), [
      "date: STAGING_DATABASE_URL",
    ]);
  });

  // T-1349 (T-1343's security review, new task b): a DATABASE_REPLICA_URL in the caller's environment (db/repo/client.ts
  // reads it) leaves the deploy's environment before anything is started, as STAGING_DATABASE_URL and DATABASE_URL do, so
  // no command the deploy starts gets it, the scripts and programs that use the database included. Made up, as the
  // caller's other URL.
  const REPLICA_URL =
    "postgres://t1349_replica_login:t1349-made-up-replica-password@db-t1349-replica.example.invalid:5432/t1349_replica";
  const REPLICA_PARTS = [
    "t1349_replica_login",
    "t1349-made-up-replica-password",
    "db-t1349-replica.example.invalid",
    "t1349_replica",
  ];

  it("a DATABASE_REPLICA_URL of the caller's reaches no command, in its environment or its arguments, under allexport, bash -a -k or bash -x (T-1349)", () => {
    for (const [source, rig, extra] of sources()) {
      // [mode, its variables, bash's options, what standard error holds: a trace begins and ends at set +x]
      for (const [mode, variables, bash, stderr] of [
        ["no option", {}, [], ""],
        ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, [], ""],
        ["bash -a -k", {}, ["-a", "-k"], ""],
        ["bash -x", {}, ["-x"], "+ set +x\n"],
      ]) {
        const what = `${mode}, ${source}`;
        const result = rig.deploy({
          extra: { ...extra, DATABASE_REPLICA_URL: REPLICA_URL, ...variables },
          bash,
        });
        assert.equal(result.status, 0, `${what}: exit ${String(result.status)}`);
        assertHandedOnAlone(result, what, { others: REPLICA_PARTS });
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
    const dir = tempDir(t, "deploy-replica-control");
    const spy = spies(dir, ["date"]);
    spawnSync(path.join(spy.bin, "date"), ["-u", `/made-up/${REPLICA_URL}`], {
      env: { PATH: spy.bin, DATABASE_REPLICA_URL: REPLICA_URL },
      encoding: "utf8",
    });
    const children = spy.children();
    assert.deepEqual(whereHeld(children, REPLICA_PARTS, kindOf), ["date: env DATABASE_REPLICA_URL, args 1"]);
    assert.deepEqual(namedIn(children, ["DATABASE_REPLICA_URL"], kindOf), ["date: DATABASE_REPLICA_URL"]);
  });
});
