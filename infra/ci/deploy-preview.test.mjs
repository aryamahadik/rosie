// Tests for infra/scripts/deploy-preview.sh (factory spec 6; DL-024), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. They build a throwaway origin (a bare repository in the system temp
// folder, never the real one) with a main branch and task branches, clone it as the lead's checkout, and run
// the checkout's deploy-preview.sh with fake npm and wrangler commands that only record their calls
// (script-harness.mjs), and a fake validators' build in main's infra/build/ that records its run the same way
// (FAKE_BUILD). No STAGING_DATABASE_URL is set, so no migration runs.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

// The contract the fake build reads.
const CONTRACT = "contracts/tool-api/tool-api.v1.5.schema.json";

// main's infra/build/tool-api-validators.mjs in the throwaway origin, in place of the real build (T-1144), which
// needs Ajv and the contracts. It records its run as the fake tools record theirs, one JSON line in $FAKE_LOG:
// the script node ran, its arguments, its folder and the folder it writes, actions/src/tool-api/generated/
// beside the script's own checkout, as the real build's. Like the real build, it fails (exit 1, nothing
// written) when a contract it reads does not parse.
const FAKE_BUILD = String.raw`import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..", "..");
const out = path.join(root, "actions", "src", "tool-api", "generated");
const call = { tool: "tool-api-validators", args: process.argv.slice(2), cwd: process.cwd(), script, out };
appendFileSync(process.env.FAKE_LOG, JSON.stringify(call) + "\n");
try {
  JSON.parse(readFileSync(path.join(root, ${JSON.stringify(CONTRACT)}), "utf8"));
} catch (error) {
  console.log("FAIL tool-api validators: " + error.message);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "validators.js"), "export const definitions = {};\n");
console.log("tool-api validators: written to " + path.relative(process.cwd(), out));
`;

/** A symbolic link at file to target, in place of any file there, as a branch can commit one. */
function link(target, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  symlinkSync(target, file);
}

// The branches of the throwaway origin and what each changes from main (a { link } is a symbolic link).
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
  // A contract that does not parse (contracts/ is not guarded): the validators' build fails in the worktree.
  "task/T-11-contract": { [CONTRACT]: '{ "title": \n' },
  // A branch build script: deploy-preview.sh must never run it unreviewed.
  "task/T-12-build-script": {
    "infra/build/tool-api-validators.mjs": 'console.log("the branch build script ran");\n',
  },
  // Ajv's run-time helper in a node_modules the branch adds, where the generated code's import would find it.
  "task/T-13-node-modules": {
    "actions/src/tool-api/generated/node_modules/ajv/dist/runtime/equal.js": "module.exports = () => true;\n",
  },
  // A link named node_modules, to a folder of the branch's own.
  "task/T-14-node-modules-link": { "actions/src/tool-api/node_modules": { link: "../../../runtime/src" } },
  // The same names in other letter case, which this Mac's volume ignores (DL-453): to node and npm they are a
  // node_modules folder, a package.json (whose name and exports point the generated code's ajv imports at the
  // branch's files) and an .npmrc. None of them is a name main has, so each is a new file on any volume.
  "task/T-15-node-modules-case": {
    "actions/src/tool-api/generated/Node_Modules/ajv/dist/runtime/equal.js": "module.exports = () => true;\n",
  },
  "task/T-16-package-json-case": {
    "actions/src/tool-api/generated/PACKAGE.JSON":
      '{ "name": "ajv", "exports": { "./dist/runtime/*": "./runtime/*" } }\n',
  },
  "task/T-17-npmrc-case": { ".NPMRC": "registry=https://registry.example.invalid/\n" },
  // A link where the build writes its files, to a folder outside the checkout (DL-453).
  "task/T-18-generated-link": { "actions/src/tool-api/generated": { link: "../../../../outside" } },
  // One of main's files made a link.
  "task/T-19-file-to-link": { "runtime/src/index.ts": { link: "../../../outside/index.ts" } },
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
    write(path.join(seed, "infra", "build", "tool-api-validators.mjs"), FAKE_BUILD);
    write(path.join(seed, CONTRACT), '{ "title": "K-09 v1.5, as the fixture holds it" }\n');
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
      for (const [file, content] of Object.entries(changes)) {
        if (typeof content === "string") write(path.join(seed, file), content);
        else link(content.link, path.join(seed, file));
      }
      // --force: .gitignore ignores node_modules/ here, as in the repository, and a branch can still commit one.
      git(seed, "add", "-A", "--force");
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
    ["task/T-12-build-script", "infra/build/tool-api-validators.mjs"],
    ["task/T-13-node-modules", "actions/src/tool-api/generated/node_modules/ajv/dist/runtime/equal.js"],
    ["task/T-14-node-modules-link", "actions/src/tool-api/node_modules"],
    ["task/T-15-node-modules-case", "actions/src/tool-api/generated/Node_Modules/ajv/dist/runtime/equal.js"],
    ["task/T-16-package-json-case", "actions/src/tool-api/generated/PACKAGE.JSON"],
    ["task/T-17-npmrc-case", ".NPMRC"],
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

  // A symbolic link in the branch's diff is refused wherever it is (mode 120000 in git diff --raw, DL-453).
  const LINKS_HEADER = "symbolic links, which could point the build at folders outside its worktree:\n";
  const links = [
    ["task/T-18-generated-link", "actions/src/tool-api/generated"],
    ["task/T-19-file-to-link", "runtime/src/index.ts"],
  ];
  for (const [branch, file] of links) {
    it(`refuses ${branch}, whose diff against origin/main makes ${file} a symbolic link, without PREVIEW_ALLOW_INFRA=1`, () => {
      const result = fixture.run(branch);
      assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.ok(
        result.stderr.includes(`${LINKS_HEADER}  ${file}\n`),
        `the refusal names ${file} as a link: ${result.stderr}`,
      );
      assert.doesNotMatch(
        result.stderr,
        /touch files that control/,
        "no guarded file changed: the link alone refuses it",
      );
      assert.match(result.stderr, /PREVIEW_ALLOW_INFRA=1/);
      assert.deepEqual(result.calls, [], "nothing is installed, built or uploaded");
      assert.equal(result.branchCfRan, false);
    });
  }

  it("names a link called node_modules both as a guarded file and as a link", () => {
    const result = fixture.run("task/T-14-node-modules-link");
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.ok(
      result.stderr.includes(
        "with the Rosfield sign-in before review:\n  actions/src/tool-api/node_modules\n" +
          `and they add, change or remove ${LINKS_HEADER}  actions/src/tool-api/node_modules\n`,
      ),
      result.stderr,
    );
    assert.deepEqual(result.calls, []);
  });

  it("with PREVIEW_ALLOW_INFRA=1 previews a reviewed link, listing it once", () => {
    const result = fixture.run("task/T-14-node-modules-link", { PREVIEW_ALLOW_INFRA: "1" });
    assertPreviewed(result, "task/T-14-node-modules-link", "task-t-14-node-modules-link");
    assert.match(
      result.stdout,
      /used as reviewed:\n {2}actions\/src\/tool-api\/node_modules\n\[/,
      "the link is listed once, though both checks name it",
    );
  });

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

  it("builds the Tool API's validators after npm ci and before the upload, with node and the worktree's guarded build script", () => {
    const result = fixture.run("task/T-1-code");
    assertPreviewed(result, "task/T-1-code", "task-t-1-code");
    assert.deepEqual(
      result.calls.map(({ tool }) => tool),
      ["npm", "tool-api-validators", "main-wrangler"],
      "npm ci, then the build, then the upload; npm runs once, so no npm script ran the build",
    );
    const [install, build, upload] = result.calls;
    const tree = install.cwd;
    assert.equal(build.cwd, tree, "the build runs in the temporary worktree");
    assert.equal(
      build.script,
      path.join(tree, "infra", "build", "tool-api-validators.mjs"),
      "node runs the worktree's infra/ copy (held to origin/main's by the guard), not the lead's checkout's",
    );
    assert.deepEqual(build.args, [], "no --out: the build's own output folder");
    assert.equal(
      build.out,
      path.join(tree, "actions", "src", "tool-api", "generated"),
      "the generated folder beside the worktree's validator.ts",
    );
    assert.equal(upload.cwd, tree, "the upload bundles the same worktree, after the build wrote into it");
    assert.match(result.stdout, /tool-api validators: written to actions\/src\/tool-api\/generated\n/);
  });

  it("stops when the validators' build fails: nothing is migrated or uploaded, and the worktree is removed", () => {
    const result = fixture.run("task/T-11-contract");
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.deepEqual(
      result.calls.map(({ tool }) => tool),
      ["npm", "tool-api-validators"],
      "no upload after the failed build",
    );
    assert.match(result.stdout, /FAIL tool-api validators: /, "the build's own failure is shown");
    assert.ok(
      result.stderr.includes(
        `the Tool API's validators did not build for task/T-11-contract (${fixture.shas["task/T-11-contract"]}):` +
          " nothing was migrated or uploaded",
      ),
      result.stderr,
    );
    assert.doesNotMatch(
      result.stdout,
      /no preview schema was migrated/,
      "it stops before the migration step",
    );
    assert.doesNotMatch(result.stdout, /Preview URL/);
    assert.equal(existsSync(result.calls[0].cwd), false, "the temporary worktree is removed");
    const worktrees = fixture.git(fixture.main, "worktree", "list", "--porcelain").match(/^worktree /gm);
    assert.equal(worktrees?.length, 1, "only the lead's checkout is left as a worktree");
  });
});
