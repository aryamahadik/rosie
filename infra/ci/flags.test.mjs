// Tests for infra/scripts/flags.sh and the flag sets of infra/flags/ (T-569; build prompt 5.4, deploy step 4; ADR-010;
// D-017 'Flag: skeleton (staging only)', 'Rollback: turn off the skeleton flag'), run by
// `node --test "infra/ci/*.test.mjs"`. The script runs in a throwaway checkout against a throwaway local database,
// migrated as the staging database is (release-harness.mjs). The Linq webhook route is the Worker's own
// (runtime/src/wiring/skeleton.ts, T-552), reading the skeleton flag through T-185's readFlag on that database; only
// the gateway's verify behind it is a stand-in, which turns every webhook away (401) once the route lets it through.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { assertNoUrlPart, badUrlRunners, createThrowawayDatabase, releaseRoot } from "./release-harness.mjs";
import { REPO } from "./script-harness.mjs";

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

  it("a staging database URL that does not parse fails every command: no part of it printed, no flag written", async () => {
    const before = await rows();
    for (const runner of badUrlRunners(t, rig, ["hash", "comment"])) {
      for (const args of [["apply"], ["off", "skeleton"], ["list"]]) {
        const what = `${runner.bad.name}, ${args.join(" ")}`;
        const result = runner.run("flags.sh", args, { DATABASE_URL: db.url });
        assert.equal(result.status, 1, `${what}: ${result.output}`);
        assert.match(result.stderr, /^flags\.sh: failed: /m, what);
        assertNoUrlPart(result, runner.bad, what);
        assert.deepEqual(await rows(), before, what);
      }
    }
  });
});
