// Tests for the parity inputs' package.json rule (T-1320; DL-589, DL-600): infra/ci/parity-inputs.mjs and the
// parity-inputs step of .github/workflows/merge-check.yml that runs it. Run by `npm run test:ci-scripts`.
//
// The shape tests run that step as the file holds it, read with the local merge-check's own reader (so the text
// the local merge-check runs) and run as Actions runs a bash step, in throwaway repositories whose origin/main
// holds this repository's package.json and rule, and read the run= line the step writes. The rule's own tests
// judge manifests as text. No database, no network.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { fill, readOutputs, readWorkflow } from "./local-merge-check.mjs";
import { PARITY_RUN, manifestVerdict, parityScripts, wordsOf } from "./parity-inputs.mjs";
import { REPO, cleanEnv, tempDir, write } from "./script-harness.mjs";

const WORKFLOW = readFileSync(path.join(REPO, ".github/workflows/merge-check.yml"), "utf8");
const RULE = readFileSync(path.join(REPO, "infra/ci/parity-inputs.mjs"), "utf8");
const MANIFEST = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
const STEP = readWorkflow(WORKFLOW)
  .jobs.find((job) => job.id === "parity-inputs")
  .steps.find((step) => step.id === "parity");

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const scriptsOf = (object) => new Map(Object.entries(object));

// The real manifest with one script line put after another (as T-1303's diff puts its line), or replaced.
function withScript(name, line, after) {
  const scripts = {};
  for (const [key, value] of Object.entries(MANIFEST.scripts)) {
    if (key !== name) scripts[key] = value;
    if (key === after || (after === undefined && key === name)) scripts[name] = line;
  }
  if (!Object.hasOwn(scripts, name)) scripts[name] = line;
  return { ...MANIFEST, scripts };
}

// The real manifest with fields changed (a value of undefined removes the field).
function withFields(fields) {
  return Object.fromEntries(
    Object.entries({ ...MANIFEST, ...fields }).filter(([, value]) => value !== undefined),
  );
}

const T1303 = withScript(
  "check-tester:token:make",
  "node infra/scripts/make-check-tester-token.mjs",
  "secrets:staging:make",
);
const T1310 = withScript("pretest:ci-scripts", "npm run build:validators", "test:scripts");

// A manifest whose test:parity runs other scripts: parity:prepare by npm run, which runs build:validators.
const CHAINED = withFields({
  scripts: {
    ...MANIFEST.scripts,
    "test:parity": "npm run parity:prepare && vitest run --project parity",
    "parity:prepare": "npm run build:validators",
  },
});

// A repository whose origin/main holds `manifest` (this repository's package.json unless given), the rule as
// `rule` gives it (this repository's unless given; null for none), a lockfile, the Vitest config, a compiler file
// and a master fixture. HEAD is task/T-1, one commit on, with `change` applied (path to text; null deletes).
function repository(t, change, { manifest = MANIFEST, rule = RULE } = {}) {
  const root = tempDir(t, "parity-repo");
  const env = cleanEnv(tempDir(t, "parity-home"));
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const files = {
    "package.json": json(manifest),
    "package-lock.json": json({ name: "rosie", version: "0.0.0", lockfileVersion: 3, requires: true }),
    "vitest.config.ts": 'export default { test: { name: "parity" } };\n',
    "compiler/src/rule.ts": "export const rule = 1;\n",
    "fixtures/master/master-A.json": json({ trades: [] }),
    "notes/base.txt": "base\n",
  };
  if (rule !== null) files["infra/ci/parity-inputs.mjs"] = rule;
  for (const [file, text] of Object.entries(files)) write(path.join(root, file), text);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "main");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("switch", "-q", "-c", "task/T-1");
  for (const [file, text] of Object.entries(change)) {
    if (text === null) rmSync(path.join(root, file));
    else write(path.join(root, file), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "the branch's change");
  return { root, env };
}

// Runs the parity-inputs step as merge-check.yml holds it, as Actions runs a bash step (the local merge-check's
// way too): { code, output, run }, run being the run= value written to GITHUB_OUTPUT (undefined for none).
function runStep(t, repo) {
  const dir = tempDir(t, "parity-step");
  const script = path.join(dir, "step.sh");
  const outputs = path.join(dir, "github-output");
  write(script, fill(STEP.run, {}));
  write(outputs, "");
  // TMPDIR: the step's mktemp -d lands in this test's folder, removed after it.
  const env = { ...repo.env, CI: "true", GITHUB_OUTPUT: outputs, TMPDIR: dir };
  const args = ["--noprofile", "--norc", "-eo", "pipefail", script];
  const result = spawnSync("bash", args, { cwd: repo.root, env, encoding: "utf8", timeout: 60_000 });
  const output = `${result.stdout}${result.stderr}`;
  return { code: result.status, output, run: readOutputs(readFileSync(outputs, "utf8")).run };
}

// The step's verdict on a branch that makes `change` over origin/main (see repository()).
function verdictOn(t, change, options) {
  const step = runStep(t, repository(t, change, options));
  assert.equal(step.code, 0, step.output);
  return step;
}

const expectRun = (t, change, run, options) => {
  const step = verdictOn(t, change, options);
  assert.equal(step.run, run, step.output);
  return step;
};

describe("parity-inputs' step: a case for each shape (T-1320)", () => {
  it("a script line alone, T-1303's shape (check-tester:token:make): not a parity input", (t) => {
    const step = expectRun(t, { "package.json": json(T1303) }, "false");
    assert.match(step.output, /only scripts the parity run never runs changed: check-tester:token:make/);
    assert.match(step.output, /package\.json changed only in script lines the parity run never runs/);
    assert.match(step.output, /No parity input changed: the parity shards are skipped\./);
  });

  it("a script line alone, T-1310's shape (pretest:ci-scripts): not a parity input", (t) => {
    const step = expectRun(t, { "package.json": json(T1310) }, "false");
    assert.match(step.output, /only scripts the parity run never runs changed: pretest:ci-scripts/);
  });

  it("other script lines changed or removed, none the parity run runs: not a parity input", (t) => {
    const changed = withScript("lint", "eslint . --max-warnings=0 --cache");
    const scripts = Object.fromEntries(
      Object.entries(changed.scripts).filter(([name]) => name !== "seed:staging"),
    );
    const step = expectRun(t, { "package.json": json({ ...changed, scripts }) }, "false");
    assert.match(step.output, /only scripts the parity run never runs changed: lint, seed:staging/);
  });

  it("a dependency, a devDependency or an overrides change: an input", (t) => {
    const cases = [
      { dependencies: { ...MANIFEST.dependencies, uqr: "0.1.4" } },
      { devDependencies: { ...MANIFEST.devDependencies, vitest: "^5.1.1" } },
      { overrides: { postgres: "3.4.9" } },
    ];
    for (const fields of cases) {
      const step = expectRun(t, { "package.json": json(withFields(fields)) }, "true");
      assert.match(step.output, new RegExp(`fields besides scripts changed: ${Object.keys(fields)[0]}`));
      assert.match(step.output, /Parity inputs changed, so the parity shards run:\npackage\.json/);
    }
  });

  it("a change to the test:parity line: an input", (t) => {
    const changed = withScript("test:parity", "vitest run --project parity --bail=1");
    const step = expectRun(t, { "package.json": json(changed) }, "true");
    assert.match(step.output, /scripts the parity run runs changed: test:parity/);
  });

  it("test:parity's own pre or post script, added: an input", (t) => {
    for (const name of ["pretest:parity", "posttest:parity"]) {
      const step = expectRun(t, { "package.json": json(withScript(name, "node infra/build/x.mjs")) }, "true");
      assert.match(step.output, new RegExp(`scripts the parity run runs changed: ${name}`));
    }
  });

  it("a script test:parity runs, and a script that one runs, followed to the end: an input", (t) => {
    const prepare = {
      ...CHAINED,
      scripts: { ...CHAINED.scripts, "parity:prepare": "npm run contracts:types" },
    };
    const validators = {
      ...CHAINED,
      scripts: { ...CHAINED.scripts, "build:validators": "node infra/build/other.mjs" },
    };
    for (const [changed, name] of [
      [prepare, "parity:prepare"],
      [validators, "build:validators"],
    ]) {
      const step = expectRun(t, { "package.json": json(changed) }, "true", { manifest: CHAINED });
      assert.match(step.output, new RegExp(`scripts the parity run runs changed: ${name}`));
    }
    // The same main with a script line the chain never reaches: not an input.
    const other = { ...CHAINED, scripts: { ...CHAINED.scripts, "check-tester:token:make": "node x.mjs" } };
    expectRun(t, { "package.json": json(other) }, "false", { manifest: CHAINED });
  });

  it("a script npm ci runs before the shards (prepare, postinstall): an input", (t) => {
    for (const name of ["prepare", "postinstall"]) {
      const step = expectRun(t, { "package.json": json(withScript(name, "node infra/build/x.mjs")) }, "true");
      assert.match(step.output, new RegExp(`scripts the parity run runs changed: ${name}`));
    }
  });

  it("a change to any other field: an input", (t) => {
    const cases = [
      { engines: { node: "^22.13.0", npm: ">=10" } },
      { type: "commonjs" },
      { workspaces: [...MANIFEST.workspaces, "tools"] },
      { imports: { "#compiler/*": "./compiler/src/*" } },
      { exports: { ".": "./index.js" } },
      { packageManager: "npm@10.9.2" },
      { resolutions: { postgres: "3.4.9" } },
      { description: "Rosie" },
    ];
    for (const fields of cases) {
      const step = expectRun(t, { "package.json": json(withFields(fields)) }, "true");
      assert.match(step.output, new RegExp(`fields besides scripts changed: ${Object.keys(fields)[0]}`));
    }
  });

  it("the lockfile, compiler/src, fixtures/master or the Vitest config: an input, as before", (t) => {
    const cases = {
      "package-lock.json": json({ name: "rosie", version: "0.0.1", lockfileVersion: 3, requires: true }),
      "compiler/src/rule.ts": "export const rule = 2;\n",
      "fixtures/master/master-B.json": json({ trades: [1] }),
      "vitest.config.ts": 'export default { test: { name: "parity", testTimeout: 1 } };\n',
    };
    for (const [file, text] of Object.entries(cases)) {
      const step = expectRun(t, { [file]: text }, "true");
      assert.ok(
        step.output.includes(`Parity inputs changed, so the parity shards run:\n${file}`),
        step.output,
      );
      assert.doesNotMatch(step.output, /parity-inputs:/, "the rule is asked about package.json alone");
    }
  });

  it("a mixed change (a script line plus a dependency, or plus a parity file): an input", (t) => {
    const lineAndDependency = { ...T1303, dependencies: { ...MANIFEST.dependencies, uqr: "0.1.4" } };
    const step = expectRun(t, { "package.json": json(lineAndDependency) }, "true");
    assert.match(step.output, /fields besides scripts changed: dependencies/);
    const lineAndFile = { "package.json": json(T1303), "compiler/src/rule.ts": "export const rule = 2;\n" };
    expectRun(t, lineAndFile, "true");
  });

  it("no parity input changed: not an input, and the rule is not asked", (t) => {
    const step = expectRun(t, { "notes/branch.txt": "branch\n" }, "false");
    assert.doesNotMatch(step.output, /parity-inputs:/);
  });

  it("the branch removes package.json, or leaves it unreadable: an input", (t) => {
    expectRun(t, { "package.json": null }, "true");
    const step = expectRun(t, { "package.json": json(T1303).replace(/\}\n$/, "},\n") }, "true");
    assert.match(step.output, /the branch's package\.json is not JSON/);
  });
});

describe("parity-inputs' step: the rule is origin/main's, and a broken rule never skips the shards", () => {
  it("the branch's own copy of the rule is never run: main's judges the branch", (t) => {
    const lenient = 'process.stdout.write("scripts-only\\n");\n';
    const change = {
      "package.json": json(withFields({ dependencies: { ...MANIFEST.dependencies, uqr: "0.1.4" } })),
      "infra/ci/parity-inputs.mjs": lenient,
    };
    const step = expectRun(t, change, "true");
    assert.match(step.output, /fields besides scripts changed: dependencies/);
  });

  it("no rule on origin/main: the step fails and writes no run=", (t) => {
    const step = runStep(t, repository(t, { "package.json": json(T1303) }, { rule: null }));
    assert.notEqual(step.code, 0, step.output);
    assert.equal(step.run, undefined);
  });

  it("a rule that exits with an error: the step fails and writes no run=", (t) => {
    const step = runStep(t, repository(t, { "package.json": json(T1303) }, { rule: "process.exit(2);\n" }));
    assert.notEqual(step.code, 0, step.output);
    assert.equal(step.run, undefined);
  });

  it("a rule that answers anything but scripts-only: package.json counts", (t) => {
    for (const rule of [
      "",
      'process.stdout.write("Scripts-only\\n");\n',
      'process.stdout.write("maybe");\n',
    ]) {
      expectRun(t, { "package.json": json(T1303) }, "true", { rule });
    }
  });
});

describe("parity-inputs.mjs: the rule on manifest text", () => {
  const verdict = (base, head) => manifestVerdict(json(base), json(head));

  it("today's test:parity runs no other script, so every other script line is outside the parity run", () => {
    const scripts = scriptsOf(MANIFEST.scripts);
    const { names, unreadable } = parityScripts(scripts, scripts);
    assert.equal(unreadable, null);
    for (const name of PARITY_RUN) {
      for (const each of [name, `pre${name}`, `post${name}`]) assert.ok(names.has(each), each);
    }
    const ran = Object.keys(MANIFEST.scripts).filter((name) => names.has(name));
    assert.deepEqual(ran, ["test:parity"]);
  });

  it("follows each way a line names a script: npm run, run-script, node --run, npm:, --script=, quoted, joined", () => {
    const lines = [
      "npm run a",
      "npm run-script a",
      "node --run a",
      "concurrently npm:a",
      "tool --script=a",
      'npm run "a"',
      "npm run 'a' -- --flag",
      'npm run "a"&&echo done',
      'npm run a"" ',
      "npm run \\a",
      "(npm run a)",
    ];
    for (const line of lines) {
      const test = scriptsOf({ "test:parity": line, a: "node a.mjs" });
      const { names } = parityScripts(test, test);
      for (const name of ["a", "prea", "posta"]) assert.ok(names.has(name), `${line}: ${name}`);
    }
    const quoted = scriptsOf({ "test:parity": 'npm run "build":validators' });
    assert.ok(parityScripts(quoted, quoted).names.has("build:validators"));
    assert.deepEqual(wordsOf('npm run "x:y" --w=z'), ["npm", "run", "x:y", "--w", "z"]);
    // A whole word only: test:unit is not test, vitest is not test.
    const unit = scriptsOf({ "test:parity": "npm run test:unit && vitest run" });
    assert.equal(parityScripts(unit, unit).names.has("test"), false);
  });

  it("npm's own commands count for the scripts they run without naming them", () => {
    const cases = {
      "npm t": ["test", "pretest", "posttest"],
      "npm tst": ["test"],
      "npm cit": ["test"],
      "npm test": ["test", "pretest", "posttest"],
      "npm restart": ["restart", "stop", "start", "prestart"],
      "npm pack": ["prepack", "prepare", "postpack"],
      "npm publish": ["prepublishOnly", "prepack", "publish", "postpublish"],
      "npm version patch": ["preversion", "version", "postversion"],
    };
    for (const [line, expected] of Object.entries(cases)) {
      const scripts = scriptsOf({ "test:parity": line });
      const { names } = parityScripts(scripts, scripts);
      for (const name of expected) assert.ok(names.has(name), `${line}: ${name}`);
    }
  });

  it("a parity line it cannot read (a variable, a command, a pattern) makes any script change an input", () => {
    for (const line of [
      "npm run $TARGET",
      "npm run `cat name`",
      "npm run $(cat name)",
      "run-s parity:*",
      "run-p parity:?",
      "npm run build:{a,b}",
      "npm run [ab]",
      "npm run %TARGET%",
    ]) {
      const main = withScript("test:parity", line);
      const result = verdict(main, { ...main, scripts: { ...main.scripts, other: "node x.mjs" } });
      assert.equal(result.input, true, line);
      assert.match(
        result.reasons[0],
        /the parity run's script test:parity names scripts this rule cannot read/,
      );
    }
    // A pattern outside the parity run's lines is no matter: test:ci-scripts' "infra/ci/*.test.mjs".
    assert.equal(verdict(MANIFEST, T1303).input, false);
  });

  it("a script name it cannot read, on either side: an input", () => {
    for (const name of ["two words", "név", "a;b", "a$b"]) {
      const result = verdict(MANIFEST, withScript(name, "node x.mjs"));
      assert.equal(result.input, true, name);
      assert.match(result.reasons[0], /is not one this rule can read/);
    }
  });

  it("every other field counts, key order included; only the scripts object is set aside", () => {
    const fields = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
      "overrides",
      "resolutions",
      "engines",
      "packageManager",
      "workspaces",
      "type",
      "imports",
      "exports",
      "main",
      "bin",
      "config",
      "name",
      "version",
      "private",
      "description",
    ];
    for (const field of fields) {
      const result = verdict(MANIFEST, withFields({ [field]: { changed: field } }));
      assert.equal(result.input, true, field);
      assert.match(result.reasons[0], new RegExp(`fields besides scripts changed: ${field}`));
    }
    const { engines, ...rest } = MANIFEST;
    assert.match(verdict(MANIFEST, { engines, ...rest }).reasons[0], /changed: \(their order\)/);
    const reordered = {
      ...MANIFEST,
      devDependencies: Object.fromEntries(Object.entries(MANIFEST.devDependencies).reverse()),
    };
    assert.match(verdict(MANIFEST, reordered).reasons[0], /changed: devDependencies/);
    assert.equal(verdict(MANIFEST, withFields({ engines: undefined })).input, true, "a removed field");
  });

  it("the same JSON in another layout, or the scripts in another order: not an input", () => {
    const layout = manifestVerdict(json(MANIFEST), `${JSON.stringify(MANIFEST)}\n`);
    assert.deepEqual(layout, { input: false, reasons: ["no field changed (the same JSON)"] });
    const scripts = Object.fromEntries(Object.entries(MANIFEST.scripts).reverse());
    assert.equal(verdict(MANIFEST, { ...MANIFEST, scripts }).input, false);
  });

  it("fails closed on a manifest it cannot read, or a scripts value that is not an object of strings", () => {
    assert.equal(manifestVerdict(null, json(MANIFEST)).input, true, "new on the branch");
    assert.equal(manifestVerdict(json(MANIFEST), null).input, true, "removed on the branch");
    assert.match(manifestVerdict(json(MANIFEST), "{").reasons[0], /the branch's package\.json is not JSON/);
    assert.match(manifestVerdict("[]", json(MANIFEST)).reasons[0], /on origin\/main is not a JSON object/);
    for (const scripts of [null, [], "npm test", { "test:parity": 1 }]) {
      const result = verdict(MANIFEST, { ...MANIFEST, scripts });
      assert.equal(result.input, true, JSON.stringify(scripts));
      assert.match(result.reasons[0], /scripts value that is not an object of strings/);
    }
  });
});
