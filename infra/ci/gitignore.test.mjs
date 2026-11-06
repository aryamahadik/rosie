// Tests for the repository's .gitignore (factory spec notes: the lead session's lock files in .claude/ are
// git-ignored, and the rest of .claude/ is committed by path), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. The .gitignore is copied into a throwaway git repository with no global
// or local excludes, so only its own patterns decide.

import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO, cleanEnv, tempDir } from "./script-harness.mjs";

function ignored(t, paths) {
  const root = tempDir(t, "gitignore");
  const home = tempDir(t, "gitignore-home");
  const env = cleanEnv(home, { XDG_CONFIG_HOME: path.join(home, ".config") });
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  copyFileSync(path.join(REPO, ".gitignore"), path.join(root, ".gitignore"));
  return Object.fromEntries(
    paths.map((file) => {
      const result = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: root, env });
      assert.ok(
        result.status === 0 || result.status === 1,
        `git check-ignore failed: ${String(result.stderr)}`,
      );
      return [file, result.status === 0];
    }),
  );
}

describe(".gitignore", () => {
  it("ignores the lead session's lock files, personal settings and builder worktrees in .claude/", (t) => {
    const files = [
      ".claude/scheduled_tasks.lock",
      ".claude/another-session.lock",
      ".claude/settings.local.json",
      ".claude/worktrees/task-T-1/runtime/src/index.ts",
    ];
    assert.deepEqual(ignored(t, files), Object.fromEntries(files.map((file) => [file, true])));
  });

  it("keeps the committed parts of .claude/ (settings, hooks, agents, skills) and the scripts", (t) => {
    const files = [
      ".claude/settings.json",
      ".claude/hooks/guard.mjs",
      ".claude/agents/architect.md",
      ".claude/skills/task-card/SKILL.md",
      "infra/scripts/cf.sh",
      "infra/ci/cf.test.mjs",
    ];
    assert.deepEqual(ignored(t, files), Object.fromEntries(files.map((file) => [file, false])));
  });

  it("still ignores the keys", (t) => {
    const files = [".env", ".env.staging", ".dev.vars", ".dev.vars.staging"];
    assert.deepEqual(ignored(t, files), Object.fromEntries(files.map((file) => [file, true])));
  });
});
