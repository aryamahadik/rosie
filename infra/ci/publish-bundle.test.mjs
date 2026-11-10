// Tests for infra/scripts/publish-bundle.sh (T-569; build prompt 5.4, deploy step 3; K-05 v1 item 7, NQ-PB-5), run by
// `node --test "infra/ci/*.test.mjs"`. The script runs in a throwaway checkout against a throwaway local database,
// migrated as the staging database is (release-harness.mjs); on the staging path its wrangler is a fake that records
// each call, so nothing reaches Cloudflare.
import assert from "node:assert/strict";
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

describe("publish-bundle.sh", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  let db;
  let rig;
  let v0;

  before(async () => {
    db = await createThrowawayDatabase("publish");
    rig = releaseRoot(t);
    v0 = path.join(rig.root, "bundles", "v0");
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
  });

  const local = (...args) =>
    rig.run("publish-bundle.sh", ["--env", "local", ...args], { DATABASE_URL: db.url });
  const staging = (args, extra = {}) =>
    rig.run("publish-bundle.sh", args, { STAGING_DATABASE_URL: db.url, ...extra });
  const registry = async () =>
    Array.from(
      await db.sql`select hash || '/' || build as id, active from bundles order by build`,
      (row) => `${row.id}${row.active ? " (active)" : ""}`,
    );
  const wranglerCalls = () => rig.calls().filter((call) => call.tool === "wrangler");

  it("publishes bundles/v0 to local PostgreSQL, then readActiveBundle returns v0's id", async () => {
    assert.equal(await readActive(db.sql), "none");
    const result = local(v0);
    assert.equal(result.status, 0, result.output);
    assert.equal(await readActive(db.sql), V0_ID);
    assert.match(result.stdout, /step 1\/3 PostgreSQL's copy[\s\S]*step 2\/3 KV: skipped[\s\S]*step 3\/3/);
    assert.match(result.stdout, new RegExp(`active bundle id: none -> ${V0_ID} \\(K-05 setActiveBundle\\)`));
    assert.match(result.stdout, new RegExp(`readActiveBundle: ${V0_ID} \\(active since `));
    const keys = await db.sql`select key from bundle_values order by key`;
    assert.deepEqual(
      Array.from(keys, (row) => row.key),
      [...V0_KEYS].sort(),
    );
    assert.deepEqual(wranglerCalls(), [], "local has no KV namespace, so wrangler is never run");
  });

  it("runs again as a repeat: nothing new is written, and v0 stays active", async () => {
    const result = local(v0);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /already published at .* with these bytes, so nothing new was written/);
    assert.match(result.stdout, new RegExp(`active bundle id: ${V0_ID}, already active`));
    assert.deepEqual(await registry(), [`${V0_ID} (active)`]);
  });

  it("a failed publish leaves the old active id: a bundle whose files do not hold its id is refused", async () => {
    const broken = v0WithBuild(t, 3);
    const flow = path.join(broken.dir, "flow", "A.json");
    writeFileSync(flow, readFileSync(flow, "utf8").replace("S1-02", "S1-0X"));
    const result = local(broken.dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /refused: [\s\S]*nothing was written/);
    assert.doesNotMatch(result.stdout, /step 3\/3/);
    assert.equal(await readActive(db.sql), V0_ID);
    assert.deepEqual(await registry(), [`${V0_ID} (active)`]);
  });

  it("a failed switch leaves the old active id: an id never published is refused (notPublished)", async () => {
    const unpublished = v0WithBuild(t, 9).id;
    const result = local("--activate", unpublished);
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      new RegExp(`bundle ${unpublished} is not published \\(K-05 setActiveBundle: notPublished\\)`),
    );
    assert.equal(await readActive(db.sql), V0_ID);
  });

  it("switches to another bundle, and --activate switches back: a bundle rollback is the same switch", async () => {
    const build2 = v0WithBuild(t, 2);
    const record = path.join(rig.dir, "switch.json");
    const published = local("--record", record, build2.dir);
    assert.equal(published.status, 0, published.output);
    assert.equal(await readActive(db.sql), build2.id);
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { before: V0_ID, after: build2.id });
    const back = local("--activate", V0_ID);
    assert.equal(back.status, 0, back.output);
    assert.match(back.stdout, new RegExp(`active bundle id: ${build2.id} -> ${V0_ID}`));
    assert.equal(await readActive(db.sql), V0_ID);
    assert.deepEqual(await registry(), [`${V0_ID} (active)`, build2.id]);
    const status = local("--status");
    assert.equal(status.status, 0, status.output);
    assert.match(status.stdout, new RegExp(`active bundle id: ${V0_ID} \\(active since `));
  });

  it("staging: PostgreSQL's copy, then the KV bulk file into BUNDLES, then the switch", async () => {
    const build4 = v0WithBuild(t, 4);
    const callsBefore = rig.calls().length;
    const result = staging([build4.dir]);
    assert.equal(result.status, 0, result.output);
    assert.match(
      result.stdout,
      /step 1\/3 PostgreSQL's copy[\s\S]*step 2\/3 KV: wrangler kv bulk put[\s\S]*step 3\/3/,
    );
    const calls = rig.calls().slice(callsBefore);
    const put = calls.find((call) => call.tool === "wrangler");
    assert.deepEqual(put.args.slice(0, 2), ["--config", path.join(rig.root, "wrangler.jsonc")]);
    assert.deepEqual(put.args.slice(2, 5), ["kv", "bulk", "put"]);
    assert.deepEqual(put.args.slice(6), ["--binding", "BUNDLES", "--env", "staging", "--remote"]);
    const { entries } = calls.find((call) => call.tool === "kv");
    assert.deepEqual(
      entries.map((entry) => entry.key),
      build4.keys,
    );
    assert.equal(entries[1].value, readFileSync(path.join(build4.dir, "flow", "A.json"), "utf8"));
    assert.equal(await readActive(db.sql), build4.id);
  });

  it("staging: a failed KV upload stops before the switch, so the old active id stays", async () => {
    const back = staging(["--activate", V0_ID]);
    assert.equal(back.status, 0, back.output);
    const build5 = v0WithBuild(t, 5);
    const result = staging([build5.dir], { FAKE_KV: "fail" });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.stdout, /step 2\/3 KV: wrangler kv bulk put/);
    assert.doesNotMatch(result.stdout, /step 3\/3/);
    assert.equal(await readActive(db.sql), V0_ID);
    assert.ok((await registry()).includes(build5.id), "PostgreSQL's copy is published, and not active");
  });

  it("staging: refused while STAGING_DATABASE_URL is not set (J-06), with nothing run", () => {
    const callsBefore = rig.calls().length;
    const result = rig.run("publish-bundle.sh", [v0]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /STAGING_DATABASE_URL is not set: staging has no database yet \(J-06\)/);
    assert.equal(rig.calls().length, callsBefore);
  });

  it("refuses --env production before anything is read or written", async () => {
    const registered = await registry();
    const callsBefore = rig.calls().length;
    for (const args of [
      ["--env", "production", v0],
      ["--env=production", v0],
      [v0, "--env", "production"],
      ["--env", "production", "--activate", V0_ID],
      ["--env", "production", "--status"],
    ]) {
      const result = rig.run("publish-bundle.sh", args, {
        STAGING_DATABASE_URL: db.url,
        DATABASE_URL: db.url,
      });
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.output}`);
      assert.match(result.stderr, /refused: --env production is never run from here/, args.join(" "));
      assert.doesNotMatch(result.stdout, /publish-bundle:/, args.join(" "));
    }
    assert.deepEqual(await registry(), registered);
    assert.equal(rig.calls().length, callsBefore);
  });

  it("refuses any other --env, and --env local with a database on another host", () => {
    const other = rig.run("publish-bundle.sh", ["--env", "preview", v0], { STAGING_DATABASE_URL: db.url });
    assert.equal(other.status, 1, other.output);
    assert.match(other.stderr, /only --env staging \(the default\) or --env local/);
    const remote = rig.run("publish-bundle.sh", ["--env", "local", v0], {
      DATABASE_URL: "postgres://rosie:rosie@db.example.invalid:5432/rosie",
    });
    assert.equal(remote.status, 1, remote.output);
    assert.match(remote.stderr, /--env local writes only a database on this machine/);
    assert.doesNotMatch(remote.output, /example\.invalid/);
  });

  it("refuses a folder that holds no bundle", () => {
    const result = local(rig.dir);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /holds no bundle: no manifest\.json in it or in its bundle\/ folder/);
    assert.ok(existsSync(rig.dir));
  });

  it("a staging database URL that does not parse is refused on every path: no part of it printed, nothing written", async () => {
    // Build 6 active, build 7 published and not active, build 8 never published.
    const active = v0WithBuild(t, 6);
    const other = v0WithBuild(t, 7);
    const unpublished = v0WithBuild(t, 8);
    for (const bundle of [other, active]) {
      const published = local(bundle.dir);
      assert.equal(published.status, 0, published.output);
    }
    assert.equal(await readActive(db.sql), active.id);
    const registered = await registry();
    const paths = [
      ["--status", ["--status"]],
      ["--activate <id>", ["--activate", other.id]],
      ["a publish", [unpublished.dir]],
    ];
    for (const runner of badUrlRunners(t, rig, ["hash", "hashAfterDigits", "comment"])) {
      for (const [which, args] of paths) {
        const what = `${runner.bad.name}, ${which}`;
        const callsBefore = runner.calls().length;
        const result = runner.run("publish-bundle.sh", args, { DATABASE_URL: db.url });
        assert.equal(result.status, 1, `${what}: ${result.output}`);
        assert.match(
          result.stderr,
          /^publish-bundle\.sh: refused: the staging database URL does not parse: .+; nothing was read or written$/m,
          what,
        );
        assertNoUrlPart(result, runner.bad, what);
        assert.equal(await readActive(db.sql), active.id, what);
        assert.deepEqual(await registry(), registered, what);
        assert.equal(runner.calls().length, callsBefore, `${what}: wrangler never ran`);
      }
    }
  });

  it("each way a database URL can fail its check is refused by name, before any client is built", async () => {
    const active = await readActive(db.sql);
    // Made up: no such user or password exists, and a .invalid host never resolves.
    const user = "staging_owner_t569";
    const host = "db-t569.example.invalid";
    const cases = [
      ["staging", "it holds a quote or a space", `postgres://${user}:Qx7Lm9@${host}:5432/rosie `, "Qx7Lm9"],
      ["staging", "it is not a URL", `postgres://${user}:Qx/7Lm@${host}:5432/rosie`, "Qx/7Lm"],
      [
        "staging",
        "it is not a postgres:// or postgresql:// URL",
        `mysql://${user}:Qx7Lm9@${host}/rosie`,
        "Qx7Lm9",
      ],
      ["staging", "it names no host", "postgres:///t569_no_host", "t569_no_host"],
      // A / or ? after digits: the rest still parses, as a URL whose host is the user.
      ["staging", "it holds an @ after its host", `postgres://${user}:12/Qx7Lm@${host}:5432/rosie`, "Qx7Lm"],
      ["staging", "it holds an @ after its host", `postgres://${user}:12?Qx7Lm@${host}:5432/rosie`, "Qx7Lm"],
      [
        "staging",
        "a % in its user, password or database name starts no escape",
        `postgres://${user}:Qx7%zzLm@${host}:5432/rosie`,
        "Qx7%zzLm",
      ],
      ["local", "it holds a #", `postgres://${user}:Qx7#Lm9@127.0.0.1:54329/rosie`, "Qx7#Lm9"],
    ];
    for (const [env, fault, url, password] of cases) {
      const what = `${env}: ${fault}`;
      const result =
        env === "staging"
          ? rig.run("publish-bundle.sh", ["--status"], { STAGING_DATABASE_URL: url, DATABASE_URL: db.url })
          : rig.run("publish-bundle.sh", ["--env", "local", "--status"], { DATABASE_URL: url });
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      const refusal = `publish-bundle.sh: refused: the ${env} database URL does not parse: ${fault}`;
      assert.ok(result.stderr.startsWith(refusal), `${what}: ${result.stderr}`);
      assertNoUrlPart(result, { parts: [user, host, "127.0.0.1", password] }, what);
    }
    assert.equal(await readActive(db.sql), active);
  });

  it("a database that refuses the connection: the fault is named, and no part of its URL is printed", async () => {
    const active = await readActive(db.sql);
    // Port 1 of this machine refuses a connection at once; the user, password and database name are made up.
    const refused = {
      url: "postgres://refused_user_t569:Pw9sK2mX7@127.0.0.1:1/t569_nowhere",
      parts: ["refused_user_t569", "Pw9sK2mX7", "127.0.0.1", "t569_nowhere"],
    };
    for (const args of [["--status"], ["--activate", V0_ID], [v0]]) {
      const what = args.join(" ");
      const result = rig.run("publish-bundle.sh", ["--env", "local", ...args], { DATABASE_URL: refused.url });
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.match(result.stderr, /^publish-bundle\.sh: the database call failed \(ECONNREFUSED\): /m, what);
      assertNoUrlPart(result, refused, what);
    }
    assert.equal(await readActive(db.sql), active);
  });
});
