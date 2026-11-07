// T-1058: ci.yml runs once per push (pull_request, plus push to main only), and keeps every step. T-1067 adds
// two steps (the parity inputs check and the parity run); infra/ci/parity-placement.test.mjs proves them.
// No YAML dependency: this reads only the few lines it needs from the workflow file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const lines = readFileSync(file, "utf8").split("\n");

// The lines of one top-level block (a key at column 0), without comments or blank lines.
function block(key) {
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  assert.notEqual(start, -1, `ci.yml has a top-level "${key}:"`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    if (l.trim() === "" || l.trim().startsWith("#")) continue;
    out.push(l);
  }
  return out;
}

// The entries under "on:" at two spaces: { push: [lines], pull_request: [lines] }.
function triggers() {
  const result = {};
  let current = null;
  for (const l of block("on")) {
    const m = /^ {2}([a-z_]+):(.*)$/.exec(l);
    if (m) {
      current = m[1];
      result[current] = [];
    } else if (current) {
      result[current].push(l.trim());
    }
  }
  return result;
}

test("push runs on main only", () => {
  const t = triggers();
  assert.ok("push" in t, "on.push is present");
  const branches = t.push.find((l) => l.startsWith("branches:"));
  assert.ok(branches, "on.push.branches is present");
  const list = /^branches:\s*\[(.*)\]\s*$/.exec(branches);
  assert.ok(list, "on.push.branches is an inline list");
  const names = list[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  assert.deepEqual(names, ["main"]);
});

test("pull_request is present", () => {
  assert.ok("pull_request" in triggers());
});

test("concurrency cancels in-progress runs of the same ref", () => {
  const c = block("concurrency").map((l) => l.trim());
  const group = c.find((l) => l.startsWith("group:"));
  const cancel = c.find((l) => l.startsWith("cancel-in-progress:"));
  assert.ok(group, "a concurrency group is set");
  assert.match(group, /github\.head_ref \|\| github\.ref_name/, "the group is per ref");
  assert.ok(cancel, "cancel-in-progress is set");
  assert.notEqual(cancel.split(":")[1].trim(), "false");
  assert.match(cancel, /github\.ref != 'refs\/heads\/main'/, "main runs are never cancelled");
});

test("no job or step is removed", () => {
  const jobsText = block("jobs");
  const jobs = jobsText.filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l)).map((l) => l.trim());
  assert.deepEqual(jobs, ["checks:"]);
  const steps = jobsText
    .map((l) => /^ {6}- name: (.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.deepEqual(steps, [
    "Check out (full history, so the guards can compare with origin/main)",
    "Set up Node (version from .nvmrc)",
    "Install from the lockfile",
    "Contract types (generated into contracts/generated/, git-ignored, never committed)",
    "Contract fixtures (each against its schema; no-op until the contracts workspace has the script)",
    "Format",
    "Lint",
    "Type check",
    "Tests (unit, workers, contract)",
    "Parity inputs changed (overlay, load, graph, master fixtures, Vitest config, manifest, lockfile)",
    "Overlay parity (only when its inputs changed)",
    "CI script tests (the guards and the PreToolUse hook)",
    "Test guard (no fewer tests, no new skip, todo or only)",
    "Migration guard (migrations only expand)",
    "Frozen-contract guard (no edit to a schema or fixture of a frozen version)",
  ]);
});
