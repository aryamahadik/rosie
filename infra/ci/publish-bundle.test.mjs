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
    const unpublished = `${V0_ID.split("/")[0]}/9`;
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
});
