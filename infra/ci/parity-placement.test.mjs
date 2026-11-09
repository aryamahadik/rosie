// T-1067: the overlay parity shards (compiler/src/**/parity.shard-*.test.ts, T-135) are their own Vitest project,
// "parity", outside `npm test`. T-1078: ci.yml never runs them; merge-check.yml runs them in N parallel shard jobs
// (no database service) only when a parity input changed. No YAML or TypeScript parser: this reads the few lines
// it needs as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");

const vitestConfig = read("vitest.config.ts");
const pkg = JSON.parse(read("package.json"));

const PARITY_GLOB = "compiler/src/**/parity.shard-*.test.ts";
// The inputs of the parity (card T-1067), in the order the workflows list them.
const PARITY_INPUTS = [
  "compiler/src",
  "fixtures/master",
  "vitest.config.ts",
  "package.json",
  "package-lock.json",
];

// Every parity shard in the repository, found from the glob (T-1076), not a fixed list.
function findShards(dir) {
  const found = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...findShards(rel));
    else if (path.matchesGlob(rel, PARITY_GLOB)) found.push(rel);
  }
  return found.sort();
}
const SHARDS = findShards("compiler/src");

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

test("every parity shard on disk is found: overlay and slots hold shards 1 to 8, corrections 1 to 9", () => {
  for (const [folder, last] of Object.entries({ overlay: 8, slots: 8, corrections: 9 })) {
    const own = SHARDS.filter((s) => s.startsWith(`compiler/src/${folder}/`));
    assert.deepEqual(
      own,
      Array.from({ length: last }, (_, i) => `compiler/src/${folder}/parity.shard-${i + 1}.test.ts`).sort(),
    );
  }
  assert.ok(SHARDS.length >= 24, `${SHARDS.length} shards found`);
  console.log(`parity shards found (${SHARDS.length}):\n${SHARDS.join("\n")}`);
});

test("the parity glob is one constant, and it matches every shard and nothing else", () => {
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

const withoutComments = (text) =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

// The jobs of a workflow: { name: text }, split at a key of two spaces under "jobs:".
function jobs(file) {
  const lines = read(file).split("\n");
  const start = lines.findIndex((l) => l.startsWith("jobs:"));
  assert.notEqual(start, -1, `${file} has jobs:`);
  const out = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      out[current] = "";
    } else if (current) out[current] += `${line}\n`;
  }
  return out;
}

// The steps of one job's text: { name, text }, split at "      - name:" (six spaces).
function stepsOf(jobText) {
  const out = [];
  for (const line of jobText.split("\n")) {
    const m = /^ {6}- name: (.*)$/.exec(line);
    if (m) out.push({ name: m[1], text: "" });
    else if (out.length > 0) out[out.length - 1].text += `${line}\n`;
  }
  return out;
}

const CI = ".github/workflows/ci.yml";
const MC = ".github/workflows/merge-check.yml";
const mc = jobs(MC);
const SHARD_JOB = mc["parity-shard"];
const INPUTS_JOB = mc["parity-inputs"];
const rebaseOf = (jobText) => {
  const step = stepsOf(jobText).find((s) => s.name.startsWith("Rebase onto origin/main"));
  assert.ok(step, "the job has a rebase step");
  // The rebase itself: from the git config to the closing fi of the conflict check.
  const m = /git config user\.name[\s\S]*?\n {10}fi\n/.exec(step.text);
  assert.ok(m, "the rebase step has its conflict check");
  return m[0];
};

test("ci.yml has no parity step: no parity run, no inputs check, no parity id", () => {
  const text = withoutComments(read(CI));
  assert.doesNotMatch(text, /test:parity/);
  assert.doesNotMatch(text, /parity/i);
  assert.doesNotMatch(text, /--shard/);
  assert.ok(!stepsOf(read(CI)).some((s) => /parity/i.test(s.name)));
});

for (const file of [CI, MC]) {
  test(`${file}: npm test stays in its step and does not name the parity glob`, () => {
    const all = file === MC ? stepsOf(mc["merge-check"]) : stepsOf(jobs(file).checks);
    const tests = all.find((s) => s.name === "Tests (unit, workers, contract)");
    assert.ok(tests);
    assert.match(tests.text, /^\s+run: npm test\s*$/m);
    assert.doesNotMatch(withoutComments(tests.text), /parity/);
  });
}

test("merge-check.yml has the merge-check job, the input check job and the shard job", () => {
  assert.deepEqual(Object.keys(mc), ["merge-check", "parity-inputs", "parity-shard"]);
  assert.ok(
    !stepsOf(mc["merge-check"]).some((s) => /parity/i.test(s.name)),
    "no parity step in the merge-check job",
  );
  assert.doesNotMatch(withoutComments(mc["merge-check"]), /test:parity/);
});

test("merge-check.yml: the input check job lists exactly T-1076's inputs and compares the rebased branch with origin/main", () => {
  const steps = stepsOf(INPUTS_JOB);
  const check = steps.find((s) => /^ {8}id: parity\s*$/m.test(s.text));
  assert.ok(check, "a step with id parity");
  const list = /inputs=\(([^)]*)\)/.exec(check.text);
  assert.ok(list, "the inputs are one list");
  assert.deepEqual(list[1].trim().split(/\s+/), PARITY_INPUTS);
  const diffs = check.text.split("\n").filter((l) => l.includes("git diff"));
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /git diff --name-only origin\/main\.\.\.HEAD -- "\$\{inputs\[@\]\}"/);
  assert.doesNotMatch(check.text, /HEAD\^/);
  assert.match(check.text, /echo "run=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(check.text, /echo "run=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(INPUTS_JOB, /^ {6}run: \$\{\{ steps\.parity\.outputs\.run \}\}\s*$/m, "the job outputs run");
  assert.ok(
    steps.findIndex((s) => s.name.startsWith("Rebase onto origin/main")) < steps.indexOf(check),
    "it rebases before it looks at the changed paths",
  );
  assert.doesNotMatch(INPUTS_JOB, /^ {4}services:/m);
});

test("merge-check.yml: the shard job needs the input check, runs only when it said run, and has no database service", () => {
  assert.match(SHARD_JOB, /^ {4}needs: parity-inputs\s*$/m);
  assert.match(SHARD_JOB, /^ {4}if: needs\.parity-inputs\.outputs\.run == 'true'\s*$/m);
  assert.doesNotMatch(SHARD_JOB, /^ {4}services:/m);
  assert.doesNotMatch(withoutComments(SHARD_JOB), /postgres|DATABASE_URL/i);
});

test("merge-check.yml: the shard job rebases exactly as the merge-check job does", () => {
  assert.equal(rebaseOf(SHARD_JOB), rebaseOf(mc["merge-check"]));
  assert.equal(rebaseOf(INPUTS_JOB), rebaseOf(mc["merge-check"]));
  const steps = stepsOf(SHARD_JOB).map((s) => s.name);
  assert.ok(
    steps.findIndex((n) => n.startsWith("Rebase onto origin/main")) <
      steps.findIndex((n) => n.startsWith("Install")),
  );
  assert.match(SHARD_JOB, /ref: \$\{\{ inputs\.branch \}\}/);
  assert.match(SHARD_JOB, /fetch-depth: 0/);
});

test("merge-check.yml: the shard job runs shard i of N for i from 1 to N, with N as SHARD_COUNT", () => {
  const matrix = /^ {8}shard: \[([0-9, ]*)\]\s*$/m.exec(SHARD_JOB);
  assert.ok(matrix, "the matrix lists the shard numbers");
  const numbers = matrix[1].split(",").map((s) => Number(s.trim()));
  const count = /^ {6}SHARD_COUNT: (\d+)\s*$/m.exec(SHARD_JOB);
  assert.ok(count, "SHARD_COUNT is set");
  const n = Number(count[1]);
  assert.deepEqual(
    numbers,
    Array.from({ length: n }, (_, i) => i + 1),
  );
  assert.ok(n >= 2 && n <= SHARDS.length, `${n} shard jobs for ${SHARDS.length} files`);
  assert.match(SHARD_JOB, /name: parity shard \$\{\{ matrix\.shard \}\} of \d+/);
  assert.equal(Number(/name: parity shard \$\{\{ matrix\.shard \}\} of (\d+)/.exec(SHARD_JOB)[1]), n);
  assert.match(
    SHARD_JOB,
    /^ {8}run: npm run test:parity -- --shard="\$\{\{ matrix\.shard \}\}\/\$SHARD_COUNT"\s*$/m,
  );
  assert.match(
    SHARD_JOB,
    /^ {6}fail-fast: false\s*$/m,
    "every shard runs to its end, so one report shows all failures",
  );
  assert.match(SHARD_JOB, /^ {4}timeout-minutes: \d+\s*$/m);
});

test("merge-check.yml: the run fails when any shard job fails (no shard failure is tolerated or hidden)", () => {
  const text = withoutComments(read(MC));
  assert.doesNotMatch(text, /continue-on-error/);
  // The shard job has no always()/failure() condition that would let a failed need pass, and nothing needs it
  // in a way that skips on failure: a failed matrix job fails the workflow run, a skipped one (no input) does not.
  assert.doesNotMatch(SHARD_JOB, /always\(\)|failure\(\)|cancelled\(\)/);
  for (const [name, text2] of Object.entries(mc)) {
    if (name === "merge-check") continue;
    assert.doesNotMatch(withoutComments(text2), /always\(\)/, `${name} has no always()`);
  }
  // The shard command is the last thing its job does, and nothing after it can mask its exit code.
  const last = stepsOf(SHARD_JOB).at(-1);
  assert.match(last.text, /run: npm run test:parity -- --shard=/);
});
