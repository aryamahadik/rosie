// T-1073: the unit project's per-test and per-hook time limits are 30 s, sized for the build Mac under parallel load
// (Vitest's default is 5 s). No project lowers a limit below that default. No TypeScript parser: this reads the few
// lines it needs as text, like parity-placement.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vitestConfig = readFileSync(path.join(root, "vitest.config.ts"), "utf8");

const VITEST_DEFAULT_MS = 5000;
const PROJECTS = ["unit", "parity", "workers", "contract", "integration", "scenario", "e2e"];

// The text of one project: from its name to the next project's name (or the end).
function project(name) {
  const start = vitestConfig.indexOf(`name: "${name}"`);
  assert.notEqual(start, -1, `vitest.config.ts has a project "${name}"`);
  const next = vitestConfig.indexOf('name: "', start + 1);
  return vitestConfig.slice(start, next === -1 ? undefined : next);
}

// The millisecond value of `key: 30_000` in a text, or undefined when the key is not set.
function limit(text, key) {
  const m = new RegExp(`^\\s*${key}:\\s*([0-9_]+)\\s*,`, "m").exec(text);
  return m ? Number(m[1].replaceAll("_", "")) : undefined;
}

test("the unit project's testTimeout and hookTimeout are 30000", () => {
  const unit = project("unit");
  assert.equal(limit(unit, "testTimeout"), 30000);
  assert.equal(limit(unit, "hookTimeout"), 30000);
});

test("no project lowers a time limit below Vitest's default", () => {
  assert.equal(limit(vitestConfig.slice(0, vitestConfig.indexOf("projects:")), "testTimeout"), undefined);
  for (const name of PROJECTS) {
    for (const key of ["testTimeout", "hookTimeout"]) {
      const value = limit(project(name), key);
      if (value !== undefined) assert.ok(value >= VITEST_DEFAULT_MS, `${name}.${key} is ${value}`);
    }
  }
});
