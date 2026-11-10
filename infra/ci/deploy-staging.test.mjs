// Tests for infra/scripts/deploy-staging.sh's steps 3 and 4 and their undo (T-569; build prompt 5.4: "3. for a bundle,
// publish it, then switch the active bundle id; 4. the flags the approved cards name"; "If a step fails: stop; undo
// what can be undone (flag off, previous bundle id, previous code)"), run by `node --test "infra/ci/*.test.mjs"`.
// The deploy runs in a throwaway checkout (release-harness.mjs): wrangler is a fake that records each call (staging's
// live version never changes, so the code's rollback has nothing to roll back), curl is a fake health check, and the
// staging database is a throwaway local one, migrated as the staging database is.
import assert from "node:assert/strict";
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

  it("a staging database URL that does not parse stops the deploy at step 1: no part of it printed, nothing deployed or written", async () => {
    const active = await readActive(db.sql);
    const flag = await skeleton();
    for (const runner of badUrlRunners(t, rig, ["hash", "comment"])) {
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
