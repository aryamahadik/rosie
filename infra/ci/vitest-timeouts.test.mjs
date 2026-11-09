// T-1073: the unit project's per-test and per-hook time limits are 30 s, sized for the build Mac under parallel load
// (Vitest's default is 5 s). T-1114: the parity project has the same limits (DL-200: routing parity tests timed out
// at 5 s beside builders). T-1118: so does the integration project (DL-227: a test that made two test databases on
// the build Mac's emulated PostgreSQL timed out at 5 s). No project lowers a limit below that default. T-1113: the
// integration project runs its files one after another (fileParallelism: false; DL-106, DL-196), so files that share
// one PostgreSQL never pass its 100 connections; the root and the other projects leave file parallelism on. T-1117:
// every run uses at most VITEST_MAX_WORKERS workers when it is a positive whole number, and 3 otherwise, set once in
// the root options so every project shares it (DL-215: a resource guard on the build Mac). No TypeScript parser: this
// reads the few lines it needs as text, like parity-placement.test.mjs; only the cap, a value, is read by loading the
// config in a child Node that strips its types.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("the parity project's testTimeout and hookTimeout are 30000", () => {
  const parity = project("parity");
  assert.equal(limit(parity, "testTimeout"), 30000);
  assert.equal(limit(parity, "hookTimeout"), 30000);
});

test("the integration project's testTimeout and hookTimeout are 30000", () => {
  const integration = project("integration");
  assert.equal(limit(integration, "testTimeout"), 30000);
  assert.equal(limit(integration, "hookTimeout"), 30000);
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

// Whether a text has a line that sets fileParallelism (a comment that names it does not count).
const setsFileParallelism = (text) => /^\s*fileParallelism\s*:/m.test(text);

test("the integration project runs its files one at a time: fileParallelism: false", () => {
  assert.match(project("integration"), /^\s*fileParallelism:\s*false\s*,/m);
});

test("only the integration project sets fileParallelism; the root and every other project keep parallel files", () => {
  const rootOptions = vitestConfig.slice(0, vitestConfig.indexOf("projects:"));
  assert.ok(!setsFileParallelism(rootOptions), "the root config sets fileParallelism");
  for (const name of PROJECTS.filter((p) => p !== "integration")) {
    assert.ok(!setsFileParallelism(project(name)), `${name} sets fileParallelism`);
  }
});

// For each setting of VITEST_MAX_WORKERS (null: unset), the root options' maxWorkers (null: none) and the projects
// that set their own, from vitest.config.ts loaded in one child Node. Each import has its own query, so the config is
// evaluated afresh and reads the variable again.
function workerCaps(settings) {
  const configUrl = pathToFileURL(path.join(root, "vitest.config.ts")).href;
  const script = `
    const caps = [];
    for (const [i, setting] of ${JSON.stringify(settings)}.entries()) {
      if (setting === null) delete process.env.VITEST_MAX_WORKERS;
      else process.env.VITEST_MAX_WORKERS = setting;
      const { default: config } = await import(${JSON.stringify(configUrl)} + "?setting=" + i);
      caps.push({
        root: config.test.maxWorkers ?? null,
        projects: config.test.projects.filter((p) => p.test.maxWorkers !== undefined).map((p) => p.test.name),
      });
    }
    console.log(JSON.stringify(caps));
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", script],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("every run uses at most VITEST_MAX_WORKERS workers when it is a positive whole number, else 3", () => {
  const cases = [
    [null, 3],
    ["1", 1],
    ["5", 5],
    ["12", 12],
    ["0", 3],
    ["-2", 3],
    ["2.5", 3],
    ["3x", 3],
    ["many", 3],
    ["", 3],
  ];
  const caps = workerCaps(cases.map(([setting]) => setting));
  cases.forEach(([setting, workers], i) => {
    const label = `VITEST_MAX_WORKERS=${JSON.stringify(setting)}`;
    assert.equal(caps[i].root, workers, `${label}: the root options' maxWorkers`);
    assert.deepEqual(caps[i].projects, [], `${label}: projects with a maxWorkers of their own`);
  });
});
