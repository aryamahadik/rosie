// Tests for infra/ci/local-merge-check.mjs (T-1111, DL-190), run by `npm run test:ci-scripts` and by the
// merge-check's "CI script tests" step.
//
// The step-list tests read .github/workflows/merge-check.yml itself. The run tests clone small throwaway
// repositories that carry a copy of that same file, with every npm script a one-line recorder (step.mjs), so the
// real step list runs end to end in seconds. Each run makes and drops a database of its own on the local
// PostgreSQL: DATABASE_URL's server when it is set (inside a merge-check run), else the local rosie-pg
// (127.0.0.1:54329, factory spec 4; `npm run db:up`).

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import {
  DriftError,
  conditionHolds,
  evaluate,
  fill,
  nodeMatches,
  parseExpression,
  parseYaml,
  readOutputs,
  readWorkflow,
  stepEnvironment,
} from "./local-merge-check.mjs";
import { REPO, cleanEnv, tempDir, write } from "./script-harness.mjs";

const SCRIPT = fileURLToPath(new URL("./local-merge-check.mjs", import.meta.url));
const WORKFLOW = readFileSync(path.join(REPO, ".github/workflows/merge-check.yml"), "utf8");
const POSTGRES_ENTRY = import.meta.resolve("postgres");
const REBASE = "Rebase onto origin/main (a conflict fails the run)";

// The PostgreSQL server the runs use (its maintenance database): DATABASE_URL's, else the local rosie-pg.
function serverUrl() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://rosie:rosie@127.0.0.1:54329/rosie");
  url.pathname = "/postgres";
  return url.href;
}

async function databaseExists(name) {
  const sql = postgres(serverUrl(), { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    return rows.length > 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// The steps of one job read as plain lines, without the runner's reader: each "- name:" at six spaces with its
// uses: or the first line of its run: (the line after "run: |" for block text).
function stepsByLines(job) {
  const lines = WORKFLOW.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  assert.notEqual(start, -1, `merge-check.yml has the job ${job}`);
  const steps = [];
  for (let k = start + 1; k < lines.length && !/^ {2}\S/.test(lines[k]); k += 1) {
    const name = /^ {6}- name: (.*)$/.exec(lines[k]);
    const run = /^ {8}run: (.*)$/.exec(lines[k]);
    const uses = /^ {8}uses: (.*)$/.exec(lines[k]);
    if (name) steps.push({ name: name[1], command: null });
    else if (run) steps.at(-1).command = run[1] === "|" ? lines[k + 1].trim() : run[1];
    else if (uses) steps.at(-1).command = `uses ${uses[1]}`;
  }
  return steps;
}

describe("local-merge-check: the step list is merge-check.yml's, read from the file", () => {
  it("reads every job's steps in the file's order, as the file's own lines list them", () => {
    const workflow = readWorkflow(WORKFLOW);
    assert.deepEqual(
      workflow.jobs.map((job) => job.id),
      ["merge-check", "parity-inputs", "parity-shard"],
    );
    for (const job of workflow.jobs) {
      const read = job.steps.map((step) => ({
        name: step.name,
        command: step.uses === null ? step.run.split("\n")[0] : `uses ${step.uses}`,
      }));
      assert.deepEqual(read, stepsByLines(job.id), job.id);
    }
  });

  it("the merge-check job: install, contracts, format, lint, typecheck, npm test, CI script tests, three guards, migrate, test:scripts, integration, scenario, e2e", () => {
    const [job] = readWorkflow(WORKFLOW).jobs;
    const oneLine = job.steps.filter((step) => step.run !== null && !step.run.trim().includes("\n"));
    assert.deepEqual(
      oneLine.map((step) => step.run.trim()),
      [
        "npm ci --no-audit --no-fund",
        "npm run contracts:types",
        "npm run contracts:check",
        "npm run format:check",
        "npm run lint",
        "npm run typecheck",
        "npm test",
        'node --test "infra/ci/*.test.mjs"',
        "npm run guard:tests",
        "npm run guard:migrations",
        "npm run guard:contracts",
        "npm run migrate",
        "npm run test:scripts",
        "npm run test:integration",
        "npm run test:scenario",
        "npm run test:e2e",
        'echo "no gold set yet"',
      ],
    );
    assert.deepEqual(
      job.steps.slice(0, 4).map((step) => [step.name, step.kind]),
      [
        ["Check the branch name", "run"],
        ["Check out the branch (full history)", "checkout"],
        [REBASE, "run"],
        ["Set up Node (version from .nvmrc)", "setup-node"],
      ],
    );
    assert.equal(job.service.image, "postgis/postgis:17-3.5");
    assert.equal(job.env.DATABASE_URL, "postgres://rosie:rosie@localhost:5432/rosie");
    const evalSlice = job.steps.find((step) => step.name === "Eval smoke slice (AI changes only)");
    assert.equal(conditionHolds(evalSlice.if, { inputs: { ai_change: false }, ok: true }), false);
    assert.equal(conditionHolds(evalSlice.if, { inputs: { ai_change: true }, ok: true }), true);
    const summary = job.steps.at(-1);
    assert.equal(summary.name, "Job summary");
    assert.equal(summary.always, true);
    assert.equal(conditionHolds(summary.if, { ok: false }), true, "the summary runs after a failure too");
  });

  it("the parity shards 1/3, 2/3 and 3/3 run only when parity-inputs' rule says a parity input changed", () => {
    const [, inputs, shard] = readWorkflow(WORKFLOW).jobs;
    const rule = inputs.steps.find((step) => step.id === "parity");
    assert.match(rule.run, /git diff --name-only origin\/main\.\.\.HEAD -- "\$\{inputs\[@\]\}"/);
    assert.match(rule.run, /inputs=\(compiler\/src fixtures\/master vitest\.config\.ts package\.json /);
    assert.equal(inputs.outputs.run, "${{ steps.parity.outputs.run }}");
    assert.deepEqual(shard.needs, ["parity-inputs"]);
    const needs = (run) => ({ "parity-inputs": { result: "success", outputs: { run } } });
    assert.equal(conditionHolds(shard.if, { needs: needs("true"), ok: true }), true);
    assert.equal(conditionHolds(shard.if, { needs: needs("false"), ok: true }), false);
    assert.deepEqual(shard.matrix, { key: "shard", values: [1, 2, 3], failFast: false });
    assert.equal(shard.env.SHARD_COUNT, "3");
    const command = shard.steps.at(-1).run;
    assert.deepEqual(
      [1, 2, 3].map((n) => fill(command, { matrix: { shard: n } })),
      [1, 2, 3].map((n) => `npm run test:parity -- --shard="${n}/$SHARD_COUNT"`),
    );
  });

  it("follows the file: a new run step runs in its place; an action, key or expression it cannot mirror is refused", () => {
    const lint = "      - name: Lint\n";
    const added = WORKFLOW.replace(lint, `      - name: Extra check\n        run: npm run extra\n\n${lint}`);
    assert.notEqual(added, WORKFLOW);
    const runs = readWorkflow(added).jobs[0].steps.map((step) => step.run?.trim());
    assert.equal(runs.indexOf("npm run extra") + 1, runs.indexOf("npm run lint"));

    const install = "      - name: Install from the lockfile\n";
    const cacheStep = "      - name: Cache\n        uses: actions/cache@v4\n\n";
    const cache = WORKFLOW.replace(install, `${cacheStep}${install}`);
    assert.throws(
      () => readWorkflow(cache),
      (error) => error instanceof DriftError && /uses actions\/cache@v4/.test(error.message),
    );
    const sha = WORKFLOW.replace("run: npm run lint\n", "run: npm run lint -- ${{ github.sha }}\n");
    assert.throws(() => readWorkflow(sha), /the context github/);
    const timeout = "    timeout-minutes: 45\n";
    const container = WORKFLOW.replace(timeout, `${timeout}    container: node:22\n`);
    assert.throws(() => readWorkflow(container), /the key container/);
  });
});

describe("local-merge-check: its YAML reader, expressions and environment", () => {
  it("reads block text, folded text, quoted values, [lists], numbers, booleans and comments as YAML does", () => {
    const text = [
      "# a comment",
      "a: plain text # a comment",
      'b: "quoted: \\"x\\" # not a comment"',
      "c: 'it''s'",
      'd: [1, two, "three"]',
      "e: |",
      "  line one",
      "    indented",
      "",
      "  line three",
      "f: >-",
      "  folded",
      "  into one",
      "g:",
      "  - name: x",
      "    run: y",
      "  - 5432:5432",
      "h: true",
      "i: 0",
      "j:",
      "k: ${{ inputs.branch }}",
    ].join("\n");
    assert.deepEqual(parseYaml(text), {
      a: "plain text",
      b: 'quoted: "x" # not a comment',
      c: "it's",
      d: [1, "two", "three"],
      e: "line one\n  indented\n\nline three\n",
      f: "folded into one",
      g: [{ name: "x", run: "y" }, "5432:5432"],
      h: true,
      i: 0,
      j: null,
      k: "${{ inputs.branch }}",
    });
    assert.throws(() => parseYaml("a: &anchor x"), /line 1: a value this reader does not read/);
    assert.throws(() => parseYaml("a:\n\tb: 1"), /line 2: a tab in the indentation/);
    assert.throws(() => parseYaml("a: 1\na: 2"), /line 2: the key a twice/);
  });

  it("fills and judges expressions with Actions' rules (implicit success(), loose equality)", () => {
    const context = {
      inputs: { branch: "task/T-1", ai_change: true },
      matrix: { shard: 2 },
      job: { status: "failure" },
      needs: {},
      steps: { parity: { outputs: { run: "true" } } },
      ok: false,
    };
    const shard = fill("--shard=${{ matrix.shard }}/3 ${{ inputs.branch }}", context);
    assert.equal(shard, "--shard=2/3 task/T-1");
    const status = fill("${{ job.status }} ${{ inputs.ai_change }} [${{ steps.x.outputs.y }}]", context);
    assert.equal(status, "failure true []");
    assert.equal(evaluate(parseExpression("steps.parity.outputs.run == 'TRUE'"), context), true);
    assert.equal(conditionHolds("inputs.ai_change", context), false, "no status call: success() && ...");
    assert.equal(conditionHolds("always()", context), true);
    assert.equal(conditionHolds("${{ failure() }}", context), true);
    assert.equal(conditionHolds(null, { ...context, ok: true }), true);
    assert.throws(() => parseExpression("github.sha"), DriftError);
    assert.throws(() => parseExpression("inputs.other"), /inputs\.other is not an input/);
    assert.throws(() => parseExpression("hashFiles()"), /the call hashFiles\(\)/);
    assert.throws(() => parseExpression("contains(inputs.branch, 'x')"), DriftError);
  });

  it("matches node --version against .nvmrc as setup-node reads it, and reads step outputs", () => {
    assert.equal(nodeMatches("22\n", "v22.23.1"), true);
    assert.equal(nodeMatches("22.23", "v22.23.1"), true);
    assert.equal(nodeMatches("v22.23.1", "v22.23.1"), true);
    assert.equal(nodeMatches("20", "v22.23.1"), false);
    assert.equal(nodeMatches("22.12.0", "v22.23.1"), false);
    assert.equal(nodeMatches("lts/*", "v22.23.1"), false);
    assert.deepEqual(readOutputs("run=true\nlist<<END\na\nb\nEND\n"), { run: "true", list: "a\nb" });
  });

  it("gives steps no git, GitHub, Cloudflare, npm, database or key variable, and keeps git off the user's config", () => {
    const env = stepEnvironment({
      PATH: "/bin",
      HOME: "/home/x",
      GIT_DIR: "/elsewhere",
      GH_TOKEN: "fake",
      GITHUB_TOKEN: "fake",
      CLOUDFLARE_ACCOUNT_ID: "fake",
      STRIPE_SECRET_KEY: "fake",
      SOME_API_KEY: "fake",
      npm_config_prefix: "/p",
      CI: "1",
      DATABASE_URL: "postgres://elsewhere/db",
      DB_SCHEMA: "public",
      PGPASSWORD: "fake",
      XDG_CONFIG_HOME: "/c",
      MERGE_CHECK_PG_URL: "postgres://localhost/postgres",
    });
    assert.deepEqual(env, {
      PATH: "/bin",
      HOME: "/home/x",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    });
  });
});

// The npm scripts merge-check.yml runs, in its order (npm test runs "test"), each a recorder in the fixtures.
const SCRIPTS = [
  "contracts:types",
  "contracts:check",
  "format:check",
  "lint",
  "typecheck",
  "test",
  "guard:tests",
  "guard:migrations",
  "guard:contracts",
  "migrate",
  "test:scripts",
  "test:integration",
  "test:scenario",
  "test:e2e",
  "test:parity",
];

// step.mjs: appends its name and arguments to the log; "migrate" also connects to DATABASE_URL and writes the
// database it reached; the script named failAt exits 3; the one named sleepAt waits two minutes.
function stepProgram(log, failAt, sleepAt) {
  return `import { appendFileSync } from "node:fs";
const [name, ...rest] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, [name, ...rest].join(" ") + "\\n");
if (name === "migrate") {
  const { default: postgres } = await import(${JSON.stringify(POSTGRES_ENTRY)});
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => undefined });
  const [row] = await sql\`select current_database() as name\`;
  appendFileSync(${JSON.stringify(log)}, "database " + row.name + "\\n");
  await sql.end();
}
if (name === ${JSON.stringify(failAt)}) process.exit(3);
if (name === ${JSON.stringify(sleepAt)}) await new Promise((resolve) => setTimeout(resolve, 120000));
`;
}

// A repository whose commits carry a copy of merge-check.yml, a package.json of recorder scripts with an empty
// lockfile, .nvmrc and one passing infra/ci test. origin/main (refs/remotes/origin/main) is one commit past the
// local main, which stays behind; task/T-1 branches off the local main.
function fixture(t, options = {}) {
  const { failAt = "", sleepAt = "", mainFiles = {} } = options;
  const branchFiles = options.branchFiles ?? { "notes/branch.txt": "branch\n" };
  const root = tempDir(t, "mc-repo");
  const log = path.join(tempDir(t, "mc-log"), "steps.log");
  const env = cleanEnv(tempDir(t, "mc-home"));
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const scripts = Object.fromEntries(SCRIPTS.map((name) => [name, `node step.mjs ${name}`]));
  const pkg = { name: "mc-fixture", version: "1.0.0", private: true, type: "module", scripts };
  const lock = { name: "mc-fixture", version: "1.0.0", lockfileVersion: 3, requires: true };
  lock.packages = { "": { name: "mc-fixture", version: "1.0.0" } };
  write(path.join(root, ".github/workflows/merge-check.yml"), WORKFLOW);
  write(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  write(path.join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  write(path.join(root, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
  const passing = 'import { test } from "node:test";\ntest("ok", () => {});\n';
  write(path.join(root, "infra/ci/ok.test.mjs"), passing);
  write(path.join(root, "step.mjs"), stepProgram(log, failAt, sleepAt));
  write(path.join(root, "notes/base.txt"), "base\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  write(path.join(root, "notes/main.txt"), "main\n");
  for (const [file, text] of Object.entries(mainFiles)) write(path.join(root, file), text);
  git("add", ".");
  git("commit", "-q", "-m", "main moves on");
  const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  git("reset", "-q", "--hard", base);
  git("switch", "-q", "-c", "task/T-1");
  for (const [file, text] of Object.entries(branchFiles)) write(path.join(root, file), text);
  git("add", ".");
  git("commit", "-q", "-m", "the branch's change");
  return { root, log, base, main, head: git("rev-parse", "HEAD") };
}

// The script's arguments and environment for a run of `branch` of the repository at `repo`.
function invocation(t, repo, branch, flags) {
  const out = tempDir(t, "mc-out");
  const env = cleanEnv(tempDir(t, "mc-run-home"), { MERGE_CHECK_PG_URL: serverUrl() });
  return { out, env, args: [SCRIPT, branch, "--repo", repo, "--out-dir", out, ...flags] };
}

function readResult(out, output = "") {
  const folders = readdirSync(out);
  assert.equal(folders.length, 1, `one result folder: ${output}`);
  const folder = path.join(out, folders[0]);
  const result = JSON.parse(readFileSync(path.join(folder, "result.json"), "utf8"));
  const step = (name, job = "merge-check") => result.steps.find((s) => s.name === name && s.job === job);
  return { result, folder, step };
}

function runCheck(t, repo, branch, ...flags) {
  const { out, env, args } = invocation(t, repo, branch, flags);
  const run = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 240_000 });
  const output = `${run.stdout}${run.stderr}`;
  return { code: run.status, output, ...readResult(out, output) };
}

async function waitFor(check, what) {
  for (let waited = 0; !check(); waited += 100) {
    assert.ok(waited < 120_000, `waited two minutes for ${what}`);
    await sleep(100);
  }
}

const logLines = (file) => readFileSync(file, "utf8").trim().split("\n");

// The recorder lines a run writes up to and including `last`, with the database line after migrate.
function recorded(database, last) {
  const lines = [];
  for (const name of SCRIPTS.slice(0, SCRIPTS.indexOf(last) + 1)) {
    lines.push(name);
    if (name === "migrate") lines.push(`database ${database}`);
  }
  return lines;
}

describe("local-merge-check: runs on throwaway repositories, each against a database of its own", () => {
  it("a bad branch name fails at the branch check and exits 1; the database is dropped", async (t) => {
    const repo = fixture(t);
    for (const branch of ["feature/x", "task/a..b"]) {
      const run = runCheck(t, repo.root, branch);
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, /::error title=Bad branch::/);
      assert.equal(run.result.result, "failure");
      assert.deepEqual(run.result.failed_step, { job: "merge-check", name: "Check the branch name" });
      assert.equal(run.step("Check out the branch (full history)").status, "skipped");
      assert.equal(run.result.rebased_commit, null);
      assert.equal(run.result.database.dropped, true);
      assert.equal(await databaseExists(run.result.database.name), false);
    }
    assert.equal(existsSync(repo.log), false, "no npm step ran");
  });

  it("a branch that does not rebase cleanly onto origin/main fails at the rebase and exits 1", async (t) => {
    const repo = fixture(t, {
      mainFiles: { "notes/base.txt": "main's line\n" },
      branchFiles: { "notes/base.txt": "the branch's line\n" },
    });
    const run = runCheck(t, repo.root, "task/T-1");
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /does not rebase cleanly onto origin\/main/);
    assert.deepEqual(run.result.failed_step, { job: "merge-check", name: REBASE });
    assert.equal(run.result.branch_head, repo.head);
    assert.equal(run.result.origin_main, repo.main);
    assert.equal(run.result.rebased_commit, null);
    assert.equal(existsSync(repo.log), false, "no npm step ran");
    assert.equal(await databaseExists(run.result.database.name), false);
  });

  it("a failing step stops the run there and exits 1; the always() summary still runs; the database is dropped", async (t) => {
    const repo = fixture(t, { failAt: "test:integration" });
    const run = runCheck(t, repo.root, "task/T-1");
    assert.equal(run.code, 1, run.output);
    const database = run.result.database.name;
    assert.deepEqual(run.result.failed_step, { job: "merge-check", name: "Integration tests" });
    assert.deepEqual(logLines(repo.log), recorded(database, "test:integration"));
    assert.equal(run.step("Integration tests").status, "failure");
    assert.equal(run.step("Scenario tests").status, "skipped");
    assert.equal(run.step("End-to-end tests").status, "skipped");
    assert.equal(run.step("Eval smoke slice (AI changes only)").status, "skipped");
    assert.equal(run.step("Job summary").status, "success");
    assert.match(readFileSync(path.join(run.folder, "summary.md"), "utf8"), /- Result: failure/);
    const parity = run.result.steps.filter((step) => step.job.startsWith("parity"));
    assert.ok(parity.length > 0 && parity.every((step) => step.status === "skipped"));
    assert.equal(run.result.database.dropped, true);
    assert.equal(await databaseExists(database), false);
  });

  it("every step passing exits 0: rebased onto origin/main, the eval slice with --ai-change, no shard when no parity input changed", async (t) => {
    const repo = fixture(t);
    const run = runCheck(t, repo.root, "task/T-1", "--ai-change");
    assert.equal(run.code, 0, run.output);
    const { result } = run;
    assert.equal(result.result, "success");
    assert.equal(result.branch, "task/T-1");
    assert.equal(result.branch_ref, "refs/heads/task/T-1");
    assert.equal(result.branch_head, repo.head);
    assert.equal(result.origin_main, repo.main, "origin/main is the remote-tracking ref");
    assert.notEqual(result.origin_main, repo.base, "not the local main, which stays behind");
    assert.notEqual(result.rebased_commit, null);
    assert.notEqual(result.rebased_commit, repo.head);
    assert.equal(result.ai_change, true);
    assert.deepEqual(logLines(repo.log), recorded(result.database.name, "test:e2e"));
    const summary = readFileSync(path.join(run.folder, "summary.md"), "utf8");
    assert.ok(summary.includes(`- origin/main: \`${repo.main}\``), summary);
    assert.ok(summary.includes(`- Checked (rebased, not pushed): \`${result.rebased_commit}\``), summary);
    assert.match(summary, /- Result: success\n- Eval smoke slice: no gold set yet/);
    const job = result.steps.filter((step) => step.job === "merge-check");
    assert.deepEqual(
      job.filter((step) => step.status !== "success"),
      [],
    );
    assert.equal(run.step("Eval smoke slice (AI changes only)").status, "success");
    assert.deepEqual(
      result.jobs.map((entry) => [entry.id, entry.result]),
      [
        ["merge-check", "success"],
        ["parity-inputs", "success"],
        ["parity-shard", "skipped"],
      ],
    );
    for (const step of result.steps) {
      assert.equal(typeof step.name, "string");
      assert.equal(typeof step.command, "string");
      assert.equal(typeof step.seconds, "number");
      assert.ok(["success", "skipped", "reused"].includes(step.status), `${step.job}: ${step.name}`);
    }
    assert.equal(result.database.dropped, true);
    assert.equal(await databaseExists(result.database.name), false);
  });

  it("a branch that changes a parity input runs the shards 1/3, 2/3 and 3/3 one after another", async (t) => {
    const repo = fixture(t, { branchFiles: { "compiler/src/rule.ts": "export const rule = 1;\n" } });
    const run = runCheck(t, repo.root, "task/T-1");
    assert.equal(run.code, 0, run.output);
    assert.deepEqual(logLines(repo.log).slice(-3), [
      "test:parity --shard=1/3",
      "test:parity --shard=2/3",
      "test:parity --shard=3/3",
    ]);
    assert.deepEqual(
      run.result.jobs.map((entry) => [entry.id, entry.matrix, entry.result]),
      [
        ["merge-check", null, "success"],
        ["parity-inputs", null, "success"],
        ["parity-shard", 1, "success"],
        ["parity-shard", 2, "success"],
        ["parity-shard", 3, "success"],
      ],
    );
    const second = run.result.steps.filter((step) => step.job === "parity-shard shard=2");
    assert.deepEqual(
      second.map((step) => step.status),
      ["reused", "reused", "reused", "reused", "reused", "success"],
    );
    assert.equal(await databaseExists(run.result.database.name), false);
  });

  it("Ctrl-C stops the running step, skips the rest, drops the database and exits 130", async (t) => {
    const repo = fixture(t, { sleepAt: "lint" });
    const { out, env, args } = invocation(t, repo.root, "task/T-1", []);
    const child = spawn(process.execPath, args, { env, stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await waitFor(() => existsSync(repo.log) && logLines(repo.log).includes("lint"), "the lint step");
    child.kill("SIGINT");
    assert.equal(await exited, 130);
    const { result, step } = readResult(out);
    assert.equal(result.interrupted, "SIGINT");
    assert.equal(result.result, "failure");
    assert.deepEqual(result.failed_step, { job: "merge-check", name: "Lint" });
    assert.equal(step("Type check").status, "skipped");
    assert.deepEqual(logLines(repo.log), recorded(result.database.name, "lint"));
    assert.equal(result.database.dropped, true);
    assert.equal(await databaseExists(result.database.name), false);
  });
});
