// T-1067: the overlay parity shards (compiler/src/**/parity.shard-*.test.ts, T-135) are their own Vitest project,
// "parity", outside `npm test`; ci.yml and merge-check.yml run `npm run test:parity` only when a parity input
// changed. No YAML or TypeScript parser: this reads the few lines it needs as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");

const vitestConfig = read("vitest.config.ts");
const pkg = JSON.parse(read("package.json"));

const PARITY_GLOB = "compiler/src/**/parity.shard-*.test.ts";
// The inputs of the parity (card T-1067), in the order the workflows list them.
const PARITY_INPUTS = [
  "compiler/src/overlay",
  "compiler/src/load",
  "compiler/src/graph",
  "fixtures/master",
  "vitest.config.ts",
  "package.json",
  "package-lock.json",
];
const SHARDS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `compiler/src/overlay/parity.shard-${n}.test.ts`);

// The text of one project of vitest.config.ts: from its name to the next project's name (or the end).
function project(name) {
  const start = vitestConfig.indexOf(`name: "${name}"`);
  assert.notEqual(start, -1, `vitest.config.ts has a project "${name}"`);
  const next = vitestConfig.indexOf('name: "', start + 1);
  return vitestConfig.slice(start, next === -1 ? undefined : next);
}

// The list after `key:` (on one line, `key: [ ... ]`, or over several lines) up to its closing bracket.
function listOf(text, key) {
  const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(text);
  assert.ok(m, `"${key}" is a list`);
  return m[1];
}

test("the parity glob is one constant, and it matches the 8 shards and nothing else of the overlay", () => {
  assert.ok(vitestConfig.includes(`const PARITY_GLOB = "${PARITY_GLOB}";`));
  for (const shard of SHARDS) assert.ok(path.matchesGlob(shard, PARITY_GLOB), `${shard} matches`);
  for (const other of [
    "compiler/src/overlay/applier.test.ts",
    "compiler/src/overlay/parity.test.ts",
    "compiler/src/overlay/parity.shard-1.ts",
    "runtime/src/parity.shard-1.test.ts",
  ]) {
    assert.ok(!path.matchesGlob(other, PARITY_GLOB), `${other} does not match`);
  }
});

test("the unit project excludes the parity glob", () => {
  const unit = project("unit");
  assert.match(listOf(unit, "exclude"), /\bPARITY_GLOB\b/);
  assert.doesNotMatch(listOf(unit, "include"), /PARITY_GLOB|parity/);
  // The reason it must: unit's compiler include reaches the shard files.
  assert.ok(path.matchesGlob(SHARDS[0], "compiler/src/**/*.test.ts"));
});

test("the parity project includes exactly the parity glob", () => {
  const parity = project("parity");
  const include = listOf(parity, "include")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(include, ["PARITY_GLOB"]);
  assert.doesNotMatch(parity, /exclude:\s*\[[^\]]*PARITY_GLOB/);
});

test("no other project reaches a parity file", () => {
  for (const name of ["workers", "contract", "integration", "scenario", "e2e"]) {
    const include = listOf(project(name), "include");
    for (const pattern of [...include.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
      for (const shard of SHARDS) assert.ok(!path.matchesGlob(shard, pattern), `${name}: ${pattern}`);
    }
  }
});

test("npm test runs unit, workers and contract only; test:parity runs the parity project", () => {
  const projects = (script) => [...script.matchAll(/--project (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(projects(pkg.scripts.test), ["unit", "workers", "contract"]);
  assert.deepEqual(projects(pkg.scripts["test:parity"]), ["parity"]);
  assert.match(pkg.scripts["test:parity"], /^vitest run /);
  for (const name of ["test:unit", "test:workers", "test:contract"]) {
    assert.ok(!projects(pkg.scripts[name]).includes("parity"), `${name} does not run parity`);
  }
});

test("the config keeps passWithNoTests, so test:parity passes on main with no parity file yet", () => {
  assert.match(vitestConfig, /passWithNoTests:\s*true/);
});

// The steps of a workflow: { name, text }, split at "      - name:" (six spaces).
function steps(file) {
  const lines = read(file).split("\n");
  const out = [];
  for (const line of lines) {
    const m = /^ {6}- name: (.*)$/.exec(line);
    if (m) out.push({ name: m[1], text: "" });
    else if (out.length > 0) out[out.length - 1].text += `${line}\n`;
  }
  return out;
}

for (const file of [".github/workflows/ci.yml", ".github/workflows/merge-check.yml"]) {
  const pushes = file.endsWith("ci.yml");

  test(`${file}: the parity run is one step, under the changed-paths condition`, () => {
    const all = steps(file);
    const runs = all.filter((s) => /^\s+run: npm run test:parity\s*$/m.test(s.text));
    assert.equal(runs.length, 1, "exactly one step runs npm run test:parity");
    const [run] = runs;
    const gate = /^ {8}if: steps\.([A-Za-z0-9_-]+)\.outputs\.run == 'true'\s*$/m.exec(run.text);
    assert.ok(gate, "the parity run has an if on the changed-paths step's output");
    const check = all.find((s) => s.text.includes(`id: ${gate[1]}\n`));
    assert.ok(check, `the step with id ${gate[1]} exists`);
    assert.ok(all.indexOf(check) < all.indexOf(run), "the check comes before the run");
    assert.match(check.text, /echo "run=true" >> "\$GITHUB_OUTPUT"/);
    assert.match(check.text, /echo "run=false" >> "\$GITHUB_OUTPUT"/);
  });

  test(`${file}: the changed-paths step lists exactly the parity inputs`, () => {
    const check = steps(file).find((s) => /^ {8}id: parity\s*$/m.test(s.text));
    assert.ok(check, "a step with id parity");
    const list = /inputs=\(([^)]*)\)/.exec(check.text);
    assert.ok(list, "the inputs are one list");
    assert.deepEqual(list[1].trim().split(/\s+/), PARITY_INPUTS);
    // Every git diff compares the inputs only.
    const diffs = check.text.split("\n").filter((l) => l.includes("git diff"));
    for (const d of diffs) assert.match(d, /--name-only .* -- "\$\{inputs\[@\]\}"/);
  });

  test(`${file}: ${pushes ? "a pull request compares with origin/main, a push to main with the previous commit" : "the rebased branch is compared with origin/main"}`, () => {
    const check = steps(file).find((s) => /^ {8}id: parity\s*$/m.test(s.text));
    assert.ok(check);
    assert.match(check.text, /git diff --name-only origin\/main\.\.\.HEAD -- /);
    if (pushes) {
      assert.match(check.text, /\[ "\$GITHUB_EVENT_NAME" = "push" \]/);
      assert.match(check.text, /git diff --name-only HEAD\^ HEAD -- /);
    } else {
      assert.doesNotMatch(check.text, /HEAD\^/);
    }
  });

  test(`${file}: npm test stays in its step and does not name the parity glob`, () => {
    const tests = steps(file).find((s) => s.name === "Tests (unit, workers, contract)");
    assert.ok(tests);
    assert.match(tests.text, /^\s+run: npm test\s*$/m);
    const code = tests.text.split("\n").filter((l) => !l.trim().startsWith("#"));
    assert.doesNotMatch(code.join("\n"), /parity/);
  });
}

test("merge-check rebases onto origin/main before it looks at the changed paths", () => {
  const all = steps(".github/workflows/merge-check.yml");
  const rebase = all.findIndex((s) => s.name.startsWith("Rebase onto origin/main"));
  const check = all.findIndex((s) => /^ {8}id: parity\s*$/m.test(s.text));
  assert.notEqual(rebase, -1);
  assert.ok(rebase < check);
});
