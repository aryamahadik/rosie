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
