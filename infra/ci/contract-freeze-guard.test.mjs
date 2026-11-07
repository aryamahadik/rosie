// Tests for infra/ci/contract-freeze-guard.mjs, run in ci.yml by `node --test "infra/ci/*.test.mjs"`.
// End-to-end tests build throwaway git repositories in the system temp folder with a fake origin/main.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseFixtureIndex, parseFrozen, versionOfFile } from "./contract-freeze-guard.mjs";

const GUARD = fileURLToPath(new URL("./contract-freeze-guard.mjs", import.meta.url));

describe("readers", () => {
  it("reads the version out of a file name", () => {
    assert.equal(versionOfFile("contracts/bundle/bundle.v1.schema.json"), "1");
    assert.equal(versionOfFile("contracts/bundle/bundle.v1.1.schema.json"), "1.1");
    assert.equal(versionOfFile("contracts/db-schema/core/core.v1.tables.json"), "1");
    assert.equal(versionOfFile("contracts/bundle/README.md"), undefined);
  });

  it("reads frozen.json in its accepted shapes", () => {
    assert.deepEqual([...parseFrozen('{"frozen":["v1","1.1"]}')], ["1", "1.1"]);
    assert.deepEqual([...parseFrozen('{"frozen":{"v1":{"on":"2026-11-10"}}}')], ["1"]);
    assert.deepEqual([...parseFrozen('["v2"]')], ["2"]);
    assert.throws(() => parseFrozen("not json"), /not valid JSON/);
    assert.throws(() => parseFrozen('{"x":1}'), /must hold/);
  });

  it("reads fixtures/index.json", () => {
    const index = parseFixtureIndex('{"fixtures":[{"file":"a.json","version":"v1"},{"file":"b.json"}]}');
    assert.equal(index.get("a.json").version, "1");
    assert.equal(index.get("b.json").version, undefined);
  });
});

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
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rosie-freeze-guard-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  return {
    write(name, content) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    guard: (args = []) => spawnSync(process.execPath, [GUARD, ...args], { cwd: dir, env, encoding: "utf8" }),
    git,
    markOriginMain: () => git("update-ref", "refs/remotes/origin/main", "HEAD"),
  };
}

const SCHEMA_V1 = '{"$id":"widget.v1","type":"object"}\n';
const INDEX = JSON.stringify({
  fixtures: [
    { file: "ok-a.json", version: "v1", expect: "accept" },
    { file: "refuse-a.json", version: "v1", expect: "refuse" },
  ],
});

// widget: v1 frozen; gadget: no frozen.json (a draft)
function baseRepo(t) {
  const repo = tempRepo(t);
  repo.write("contracts/widget/frozen.json", '{"frozen":["v1"]}\n');
  repo.write("contracts/widget/widget.v1.schema.json", SCHEMA_V1);
  repo.write("contracts/widget/fixtures/index.json", INDEX);
  repo.write("contracts/widget/fixtures/ok-a.json", '{"a":1}\n');
  repo.write("contracts/widget/fixtures/refuse-a.json", '{"a":"x"}\n');
  repo.write("contracts/gadget/gadget.v1.schema.json", SCHEMA_V1);
  repo.write("contracts/gadget/fixtures/ok-g.json", "{}\n");
  repo.write("README.md", "rosie\n");
  repo.commit("base");
  repo.markOriginMain();
  repo.git("switch", "-q", "-c", "task/T-100");
  return repo;
}

describe("contract freeze guard, end to end", () => {
  it("passes a branch that changes nothing under contracts/", (t) => {
    const repo = baseRepo(t);
    repo.write("README.md", "rosie 2\n");
    repo.commit("docs");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /contract freeze guard: passed/);
  });

  it("fails an edit to a frozen schema", (t) => {
    const repo = baseRepo(t);
    repo.write("contracts/widget/widget.v1.schema.json", '{"$id":"widget.v1","type":"array"}\n');
    repo.commit("edit");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL contracts\/widget\/widget\.v1\.schema\.json: edits a file of v1/);
  });

  it("fails an edit to a frozen fixture, even when it is not committed", (t) => {
    const repo = baseRepo(t);
    repo.write("contracts/widget/fixtures/ok-a.json", '{"a":2}\n');
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL contracts\/widget\/fixtures\/ok-a\.json: edits a fixture of v1/);
  });

  it("fails removing a frozen schema, and removing a frozen fixture", (t) => {
    const repo = baseRepo(t);
    repo.git("rm", "-q", "contracts/widget/widget.v1.schema.json", "contracts/widget/fixtures/refuse-a.json");
    repo.commit("remove");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /removes a file of v1/);
    assert.match(run.stdout, /removes a fixture of v1/);
  });

  it("fails editing or dropping a frozen fixture's index entry, and unfreezing", (t) => {
    const repo = baseRepo(t);
    repo.write(
      "contracts/widget/fixtures/index.json",
      JSON.stringify({ fixtures: [{ file: "ok-a.json", version: "v1", expect: "refuse" }] }),
    );
    repo.write("contracts/widget/frozen.json", '{"frozen":[]}\n');
    repo.commit("tamper");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /index entry for ok-a\.json/);
    assert.match(run.stdout, /index entry for refuse-a\.json/);
    assert.match(run.stdout, /a freeze is never lifted/);
  });

  it("passes adding a new version file and new fixtures, and freezing another version", (t) => {
    const repo = baseRepo(t);
    repo.write("contracts/widget/widget.v1.1.schema.json", '{"$id":"widget.v1.1"}\n');
    repo.write("contracts/widget/fixtures/new-b.json", "{}\n");
    repo.write(
      "contracts/widget/fixtures/index.json",
      JSON.stringify({
        fixtures: [
          { file: "ok-a.json", version: "v1", expect: "accept" },
          { file: "refuse-a.json", version: "v1", expect: "refuse" },
          { file: "new-b.json", version: "v1.1", expect: "accept" },
        ],
      }),
    );
    repo.write("contracts/widget/frozen.json", '{"frozen":["v1","v1.1"]}\n');
    repo.commit("v1.1");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("passes editing an unfrozen draft, and an unfrozen minor version beside a frozen one", (t) => {
    const repo = baseRepo(t);
    repo.write("contracts/gadget/gadget.v1.schema.json", '{"$id":"gadget.v1","type":"array"}\n');
    repo.write("contracts/gadget/fixtures/ok-g.json", '{"g":1}\n');
    repo.commit("draft edits");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("stops with exit code 2 when origin/main is missing", (t) => {
    const repo = tempRepo(t);
    repo.write("README.md", "x\n");
    repo.commit("only");
    const run = repo.guard();
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /origin\/main was not found/);
  });
});

const TABLES_V1 = '{"tables":{"a":{}}}\n';
const CORE_V1 = "contracts/db-schema/core/core.v1.tables.json";
const BOOKING_V1 = "contracts/db-schema/booking/booking.v1.tables.json";

// Database parts: core freezes v1 first (own frozen.json); booking has none yet; widget has no parts.
// opts.bookingFrozen puts a frozen.json of its own in the booking part.
function partsRepo(t, { bookingFrozen = false } = {}) {
  const repo = tempRepo(t);
  repo.write("contracts/db-schema/core/frozen.json", '{"frozen":["v1"]}\n');
  repo.write(CORE_V1, TABLES_V1);
  repo.write(BOOKING_V1, TABLES_V1);
  if (bookingFrozen) repo.write("contracts/db-schema/booking/frozen.json", '{"frozen":["v1"]}\n');
  repo.write("contracts/widget/frozen.json", '{"frozen":["v1"]}\n');
  repo.write("contracts/widget/widget.v1.schema.json", SCHEMA_V1);
  repo.write("README.md", "rosie\n");
  repo.commit("base");
  repo.markOriginMain();
  repo.git("switch", "-q", "-c", "task/T-101");
  return repo;
}

describe("contract freeze guard, database parts", () => {
  it("a part's own frozen.json freezes that part only", (t) => {
    const repo = partsRepo(t);
    repo.write(BOOKING_V1, '{"tables":{"b":{}}}\n');
    repo.commit("edit the part that is not frozen");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("fails an edit of the frozen part's v1 table list", (t) => {
    const repo = partsRepo(t);
    repo.write(CORE_V1, '{"tables":{"b":{}}}\n');
    repo.commit("edit core");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /FAIL contracts\/db-schema\/core\/core\.v1\.tables\.json: edits a file of v1, which contracts\/db-schema\/core\/frozen\.json marks frozen/,
    );
  });

  it("fails an edit of the frozen part but passes the other part in one branch", (t) => {
    const repo = partsRepo(t);
    repo.write(CORE_V1, '{"tables":{"b":{}}}\n');
    repo.write(BOOKING_V1, '{"tables":{"b":{}}}\n');
    repo.commit("edit both");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /core\.v1\.tables\.json: edits a file of v1/);
    assert.doesNotMatch(run.stdout, /booking/);
  });

  it("fails removing the frozen part's v1 table list", (t) => {
    const repo = partsRepo(t);
    repo.git("rm", "-q", CORE_V1);
    repo.commit("remove core v1");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /core\.v1\.tables\.json: removes a file of v1/);
  });

  it("fails an edit of the second part once it has a frozen.json of its own", (t) => {
    const repo = partsRepo(t, { bookingFrozen: true });
    repo.write(BOOKING_V1, '{"tables":{"b":{}}}\n');
    repo.commit("edit booking");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /booking\.v1\.tables\.json: edits a file of v1, which contracts\/db-schema\/booking\/frozen\.json marks frozen/,
    );
  });

  it("passes adding a part's frozen.json, and adding a new minor version file to a frozen part", (t) => {
    const repo = partsRepo(t);
    repo.write("contracts/db-schema/booking/frozen.json", '{"frozen":["v1"]}\n');
    repo.write("contracts/db-schema/core/core.v1.1.tables.json", TABLES_V1);
    repo.write("contracts/db-schema/core/frozen.json", '{"frozen":["v1","v1.1"]}\n');
    repo.commit("freeze booking, add core v1.1");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("fails removing a version from a part's frozen.json", (t) => {
    const repo = partsRepo(t);
    repo.write("contracts/db-schema/core/frozen.json", '{"frozen":[]}\n');
    repo.commit("unfreeze core");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /contracts\/db-schema\/core\/frozen\.json: v1 is frozen on the base; a freeze is never lifted/,
    );
  });

  it("fails deleting a part's frozen.json", (t) => {
    const repo = partsRepo(t);
    repo.git("rm", "-q", "contracts/db-schema/core/frozen.json");
    repo.commit("delete the freeze");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /a freeze is never lifted/);
  });

  it("a frozen part's fixtures follow the part's frozen.json", (t) => {
    const repo = partsRepo(t);
    repo.write(
      "contracts/db-schema/core/fixtures/index.json",
      JSON.stringify({ fixtures: [{ file: "x.v1.json" }] }),
    );
    repo.write("contracts/db-schema/core/fixtures/x.v1.json", "{}\n");
    repo.write("contracts/db-schema/booking/fixtures/y.v1.json", "{}\n");
    repo.commit("fixtures at base");
    repo.markOriginMain();
    repo.write("contracts/db-schema/core/fixtures/x.v1.json", '{"a":1}\n');
    repo.write("contracts/db-schema/booking/fixtures/y.v1.json", '{"a":1}\n');
    repo.commit("edit fixtures");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /core\/fixtures\/x\.v1\.json: edits a fixture of v1/);
    assert.doesNotMatch(run.stdout, /booking/);
  });

  it("a contract without parts reads contracts/<name>/frozen.json exactly as before", (t) => {
    const repo = partsRepo(t);
    repo.write("contracts/widget/widget.v1.schema.json", '{"$id":"widget.v1","type":"array"}\n');
    repo.commit("edit widget");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /widget\.v1\.schema\.json: edits a file of v1, which contracts\/widget\/frozen\.json marks frozen/,
    );
  });

  it("a part with no frozen.json of its own still falls back to contracts/db-schema/frozen.json", (t) => {
    const repo = tempRepo(t);
    repo.write("contracts/db-schema/frozen.json", '{"frozen":["v1"]}\n');
    repo.write(BOOKING_V1, TABLES_V1);
    repo.commit("base");
    repo.markOriginMain();
    repo.git("switch", "-q", "-c", "task/T-102");
    repo.write(BOOKING_V1, '{"tables":{"b":{}}}\n');
    repo.commit("edit");
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /which contracts\/db-schema\/frozen\.json marks frozen/);
  });
});
