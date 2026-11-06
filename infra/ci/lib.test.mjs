// Tests for infra/scripts/lib.sh and the scripts' leftovers from before DL-024 (no GitHub deploy jobs, no CI
// token), run in ci.yml by `node --test "infra/ci/*.test.mjs"`. lib.sh is sourced from a copy in a throwaway
// git repository, so its ROOT (and the .dev.vars it reads) is that repository, never this one.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { SCRIPTS, cleanEnv, copyScript, tempDir, write } from "./script-harness.mjs";

/** Runs a bash snippet after sourcing a copy of lib.sh in a throwaway repository; extra holds files to write. */
function withLib(t, snippet, { env = {}, files = {} } = {}) {
  const root = tempDir(t, "lib");
  const home = tempDir(t, "lib-home");
  const lib = copyScript("lib.sh", root);
  for (const [name, content] of Object.entries(files)) write(path.join(root, name), content);
  const gitEnv = cleanEnv(home);
  const git = (...args) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const result = spawnSync("bash", ["-c", `set -euo pipefail; source "$1"; ${snippet}`, "lib-test", lib], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv(home, env),
  });
  return { ...result, head: git("rev-parse", "HEAD") };
}

describe("lib.sh after DL-024", () => {
  it("git_sha: GIT_SHA when set, else the checked-out commit; GitHub's GITHUB_SHA is not read", (t) => {
    const fromGithub = withLib(t, "git_sha", {
      env: { GITHUB_SHA: "1111111111111111111111111111111111111111" },
    });
    assert.equal(fromGithub.status, 0, fromGithub.stderr);
    assert.equal(fromGithub.stdout.trim(), fromGithub.head);
    const given = withLib(t, "git_sha", { env: { GIT_SHA: "2222222222222222222222222222222222222222" } });
    assert.equal(given.stdout, "2222222222222222222222222222222222222222");
  });

  it("load_dev_var reads the checkout's .dev.vars on the build Mac whether or not CI is set", (t) => {
    const files = { ".dev.vars": 'OTHER=1\nROSIE_FAKE_DEV_VAR="fake value for the test"\n' };
    const snippet =
      'load_dev_var ROSIE_FAKE_DEV_VAR; [[ "$ROSIE_FAKE_DEV_VAR" == "fake value for the test" ]]';
    for (const env of [{}, { CI: "true" }]) {
      const result = withLib(t, snippet, { env, files });
      assert.equal(result.status, 0, `with ${JSON.stringify(env)}: ${result.stderr}`);
      assert.equal(result.stdout, "", "the value is never printed");
    }
  });

  it("load_dev_var keeps a value already set", (t) => {
    const result = withLib(
      t,
      'load_dev_var ROSIE_FAKE_DEV_VAR; [[ "$ROSIE_FAKE_DEV_VAR" == "from the shell" ]]',
      {
        env: { ROSIE_FAKE_DEV_VAR: "from the shell" },
        files: { ".dev.vars": "ROSIE_FAKE_DEV_VAR=from the file\n" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  });

  it("has no GitHub Actions helpers left (gh_output, gh_summary)", (t) => {
    for (const helper of ["gh_output", "gh_summary"]) {
      const result = withLib(t, `type ${helper}`);
      assert.notEqual(result.status, 0, `${helper} is still defined`);
    }
  });
});

describe("infra/scripts after DL-024", () => {
  it("no script reads a CI token, a GitHub Actions variable or a CI-only switch", () => {
    const leftovers = /CLOUDFLARE_API_TOKEN|GITHUB_|gh_output|gh_summary|\$\{?CI\b/;
    const found = [];
    for (const name of readdirSync(SCRIPTS).filter((file) => file.endsWith(".sh"))) {
      readFileSync(path.join(SCRIPTS, name), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (leftovers.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(found, []);
  });
});
