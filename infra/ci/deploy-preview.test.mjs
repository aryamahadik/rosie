// Tests for infra/scripts/deploy-preview.sh (factory spec 6; DL-024), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. They build a throwaway origin (a bare repository in the system temp
// folder, never the real one) with a main branch and task branches, clone it as the lead's checkout, and run
// the checkout's deploy-preview.sh with fake npm and wrangler commands that only record their calls
// (script-harness.mjs). No STAGING_DATABASE_URL is set, so no migration runs.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  REPO,
  ROSFIELD_ACCOUNT_ID,
  cleanEnv,
  copyScript,
  fakeTools,
  readLog,
  tempDir,
  write,
} from "./script-harness.mjs";

const WRANGLER_JSONC = readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");

// The branches of the throwaway origin and what each changes from main.
const BRANCHES = {
  "task/T-1-code": { "runtime/src/index.ts": "export default { fetch: () => new Response('T-1') };\n" },
  "task/T-2-wrangler": {
    "wrangler.jsonc": WRANGLER_JSONC.replace('"name": "rosie-staging"', '"name": "rosie"'),
  },
  "task/T-3-infra": {
    // A branch cf.sh without any guard: deploy-preview.sh must never run it.
    "infra/scripts/cf.sh": '#!/usr/bin/env bash\necho "the branch cf.sh ran" >"$BRANCH_CF_MARKER"\n',
  },
  "task/T-4-package": { "package.json": '{ "name": "rosie", "private": true, "scripts": { "x": "y" } }\n' },
  "task/T-5-lockfile": {
    "package-lock.json": '{ "name": "rosie", "lockfileVersion": 3, "packages": { "": {} } }\n',
  },
  "task/T-6-github": { ".github/workflows/ci.yml": "name: ci\non: push\n" },
  "task/T-7-workspace-package": {
    "runtime/package.json": '{ "name": "@rosie/runtime", "version": "0.0.1" }\n',
  },
  "task/T-8-npmrc": { ".npmrc": "registry=https://registry.example.invalid/\n" },
  "task/T-10-shrinkwrap": {
    "npm-shrinkwrap.json": '{ "name": "rosie", "lockfileVersion": 3, "packages": {} }\n',
  },
};

describe("deploy-preview.sh", () => {
  let fixture;

  before(() => {
    const cleanups = [];
    const t = { after: (fn) => cleanups.push(fn) };
    const dir = tempDir(t, "preview");
    const home = path.join(dir, "home");
    write(path.join(home, ".keep"), "");
    const env = cleanEnv(home);
    const git = (cwd, ...args) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();

    // origin: main plus one branch per entry of BRANCHES.
    const origin = path.join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(dir, "seed");
    git(dir, "init", "-q", "-b", "main", seed);
    for (const script of ["deploy-preview.sh", "lib.sh", "cf.sh"]) copyScript(script, seed);
    write(path.join(seed, "wrangler.jsonc"), WRANGLER_JSONC);
    write(path.join(seed, "package.json"), '{ "name": "rosie", "private": true }\n');
    write(
      path.join(seed, "package-lock.json"),
      '{ "name": "rosie", "lockfileVersion": 3, "packages": {} }\n',
    );
    write(path.join(seed, "runtime", "package.json"), '{ "name": "@rosie/runtime" }\n');
    write(path.join(seed, "runtime", "src", "index.ts"), "export default {};\n");
    write(path.join(seed, ".github", "workflows", "ci.yml"), "name: ci\n");
    write(path.join(seed, ".gitignore"), "node_modules/\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    const shas = {};
    for (const [branch, changes] of Object.entries(BRANCHES)) {
      git(seed, "switch", "-q", "-c", branch, "main");
      for (const [file, content] of Object.entries(changes)) write(path.join(seed, file), content);
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", branch);
      git(seed, "push", "-q", "origin", branch);
      shas[branch] = git(seed, "rev-parse", "HEAD");
      git(seed, "switch", "-q", "main");
    }
    // main moves on after the branches left it: the branches are now behind it in package-lock.json and .github/.
    write(
      path.join(seed, "package-lock.json"),
      '{ "name": "rosie", "lockfileVersion": 3, "packages": { "": {} } }\n',
    );
    write(path.join(seed, ".github", "workflows", "ci.yml"), "name: ci\non: [push, pull_request]\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main moves on");
    git(seed, "push", "-q", "origin", "main");
    // A branch with no history in common with main.
    git(seed, "switch", "-q", "--orphan", "task/T-9-orphan");
    write(path.join(seed, "runtime", "src", "index.ts"), "export default {};\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "orphan");
    git(seed, "push", "-q", "origin", "task/T-9-orphan");
    git(seed, "switch", "-q", "-f", "main");

    // The lead's checkout, with its own (fake) wrangler; fake npm and wrangler first on PATH.
    const main = path.join(dir, "rosie");
    git(dir, "clone", "-q", origin, main);
    const fake = fakeTools(dir);
    fake(path.join(main, "node_modules", ".bin", "wrangler"), "main-wrangler");
    fake(path.join(dir, "bin", "npm"), "npm");
    fake(path.join(dir, "bin", "wrangler"), "wrangler-on-path");

    let runs = 0;
    const run = (branch, extra = {}) => {
      runs += 1;
      const log = path.join(dir, `calls-${runs}.ndjson`);
      const marker = path.join(dir, `branch-cf-${runs}.txt`);
      const result = spawnSync("bash", [path.join(main, "infra", "scripts", "deploy-preview.sh"), branch], {
        cwd: main,
        encoding: "utf8",
        env: cleanEnv(home, {
          PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
          FAKE_LOG: log,
          BRANCH_CF_MARKER: marker,
          ...extra,
        }),
      });
      return { ...result, calls: readLog(log), branchCfRan: existsSync(marker) };
    };
    fixture = { dir, home, main, git, shas, run, cleanup: () => cleanups.forEach((fn) => fn()) };
  });

  after(() => fixture?.cleanup());

  function assertPreviewed(result, branch, slug) {
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const npm = result.calls.filter((call) => call.tool === "npm");
    const wrangler = result.calls.filter((call) => call.tool.includes("wrangler"));
    assert.equal(npm.length, 1, "npm ci runs once, in the temporary worktree");
    const tree = npm[0].cwd;
    assert.notEqual(tree, fixture.main, "npm ci never runs in the lead's checkout");
    assert.equal(npm[0].args[0], "ci");
    assert.ok(
      npm[0].args.includes("--ignore-scripts"),
      `npm ci without --ignore-scripts: ${npm[0].args.join(" ")}`,
    );
    assert.deepEqual(
      wrangler.map(({ tool, args, cwd }) => ({ tool, args, cwd })),
      [
        {
          tool: "main-wrangler",
          args: [
            "--config",
            path.join(tree, "wrangler.jsonc"),
            "versions",
            "upload",
            "--env",
            "staging",
            "--preview-alias",
            slug,
            "--var",
            `DB_SCHEMA:preview_${slug.replaceAll("-", "_")}`,
            "--var",
            `GIT_SHA:${fixture.shas[branch]}`,
          ],
          cwd: tree,
        },
      ],
      "one upload, by the lead's checkout's wrangler (through its cf.sh), from the worktree",
    );
    assert.equal(wrangler[0].env.XDG_CONFIG_HOME, path.join(fixture.home, ".config", "rosfield"));
    assert.equal(wrangler[0].env.CLOUDFLARE_ACCOUNT_ID, ROSFIELD_ACCOUNT_ID);
    assert.equal(result.branchCfRan, false, "the branch's cf.sh must never run");
    assert.match(
      result.stdout,
      new RegExp(`Preview URL: https://${slug}-rosie-staging\\.example\\.workers\\.dev`),
    );
    assert.equal(existsSync(tree), false, "the temporary worktree is removed");
    const worktrees = fixture.git(fixture.main, "worktree", "list", "--porcelain").match(/^worktree /gm);
    assert.equal(worktrees?.length, 1, "only the lead's checkout is left as a worktree");
  }

  it("previews a branch that changes only code: npm ci --ignore-scripts, then the checkout's own cf.sh", () => {
    assertPreviewed(fixture.run("task/T-1-code"), "task/T-1-code", "task-t-1-code");
  });

  it("judges a branch by its own changes, not by what main changed after it left (as in a pull request)", () => {
    const behind = fixture.git(
      fixture.main,
      "diff",
      "--name-only",
      "origin/main",
      fixture.shas["task/T-1-code"],
    );
    assert.match(
      behind,
      /package-lock\.json/,
      "the fixture's main changed package-lock.json after T-1 left it",
    );
    assertPreviewed(fixture.run("task/T-1-code"), "task/T-1-code", "task-t-1-code");
  });

  it("refuses a branch with no history in common with origin/main", () => {
    const result = fixture.run("task/T-9-orphan");
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /no history in common/);
    assert.deepEqual(result.calls, []);
  });

  const guarded = [
    ["task/T-2-wrangler", "wrangler.jsonc"],
    ["task/T-3-infra", "infra/scripts/cf.sh"],
    ["task/T-4-package", "package.json"],
    ["task/T-5-lockfile", "package-lock.json"],
    ["task/T-6-github", ".github/workflows/ci.yml"],
    ["task/T-7-workspace-package", "runtime/package.json"],
    ["task/T-8-npmrc", ".npmrc"],
    ["task/T-10-shrinkwrap", "npm-shrinkwrap.json"],
  ];
  for (const [branch, file] of guarded) {
    it(`refuses ${branch}, whose diff against origin/main touches ${file}, without PREVIEW_ALLOW_INFRA=1`, () => {
      const result = fixture.run(branch);
      assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.ok(result.stderr.includes(file), `the refusal names ${file}: ${result.stderr}`);
      assert.match(result.stderr, /PREVIEW_ALLOW_INFRA=1/);
      assert.deepEqual(result.calls, [], "nothing is installed or uploaded");
      assert.equal(result.branchCfRan, false);
    });
  }

  it("with PREVIEW_ALLOW_INFRA=1 previews a reviewed infra change, still with the checkout's cf.sh", () => {
    const result = fixture.run("task/T-3-infra", { PREVIEW_ALLOW_INFRA: "1" });
    assertPreviewed(result, "task/T-3-infra", "task-t-3-infra");
    assert.match(result.stdout + result.stderr, /infra\/scripts\/cf\.sh/, "it lists the reviewed files");
  });

  it("with PREVIEW_ALLOW_INFRA=1, the checkout's cf.sh still refuses a wrangler.jsonc aimed at production", () => {
    const result = fixture.run("task/T-2-wrangler", { PREVIEW_ALLOW_INFRA: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rosie-staging/);
    assert.deepEqual(
      result.calls.filter((call) => call.tool.includes("wrangler")),
      [],
      "wrangler must not start",
    );
  });

  it("refuses PREVIEW_ALLOW_INFRA values other than 1", () => {
    const result = fixture.run("task/T-4-package", { PREVIEW_ALLOW_INFRA: "yes" });
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  });

  it("cleans up after itself even when the upload is refused", () => {
    const result = fixture.run("task/T-2-wrangler", { PREVIEW_ALLOW_INFRA: "1" });
    assert.notEqual(result.status, 0);
    const npm = result.calls.find((call) => call.tool === "npm");
    assert.ok(npm, "npm ci ran in a worktree");
    assert.equal(existsSync(npm.cwd), false, "the temporary worktree is removed");
  });
});
