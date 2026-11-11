// T-1191 (T-1169's new task 1, DL-375): the "contract" Vitest project holds K-05's database-side contract test
// (tests/contract/data-access.v1.db-side.test.ts, T-1169), and db/repo's resolvePrimaryUrl() never falls back to the
// local database when CI is set: with no DATABASE_URL it throws. Every GitHub runner sets CI, so every workflow step
// that runs the contract project must get a DATABASE_URL, and it must reach a PostGIS service of the step's own job,
// as merge-check.yml's job-wide URL reaches its postgis service (T-1119).
//
// Every workflow in .github/workflows is read with the local merge-check's YAML reader. A run step runs the contract
// project when its script starts a vitest run that takes the project in: vitest itself, through npx or npm exec, or
// through package.json's scripts (npm test and npm run, with their pre and post scripts, arguments and --workspace),
// as far as the step's text and those scripts show (a script file a step starts, bash x.sh or node x.mjs, is not
// read). A step runs with its workflow's, its job's and its own env, the later winning, as Actions merges them. The
// last tests show the check failing on the old ci.yml, whose URL reached its CI script tests step alone, and on
// other changed copies of the workflows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./local-merge-check.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOWS = path.join(REPO, ".github", "workflows");
const FILES = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();
const PROJECT = "contract";
const TESTS_STEP = "Tests (unit, workers, contract)";

function workflow(file) {
  return parseYaml(readFileSync(path.join(WORKFLOWS, file), "utf8"));
}

function readPackage(dir) {
  const file = path.join(dir, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// A name pattern with * as its wildcard. Case is ignored, to be safe.
function wildcard(pattern) {
  const parts = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "i");
}

// ---------------------------------------------------------------------------------------------------------------
// A shell script, read just enough to find the commands it starts. Not a shell: quotes are removed, comments
// dropped, and the script is cut into simple commands at newlines, ;, &, |, ( and ) and backquotes. An expression
// (${{ }}) or a shell variable becomes *, since it may name anything.

const VARIABLE = /\$\{\{[\s\S]*?\}\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g;

function commandsOf(script) {
  const text = script.replace(VARIABLE, "*");
  const commands = [];
  let words = [];
  let word = null;
  let quote = "";
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k];
    if (quote === "'") {
      if (ch === "'") {
        quote = "";
      } else {
        word += ch;
      }
    } else if (quote === '"') {
      if (ch === '"') {
        quote = "";
      } else if (ch === "\\" && /["\\$`]/.test(text[k + 1] ?? "")) {
        k += 1;
        word += text[k];
      } else {
        word += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (ch === "\\") {
      k += 1;
      if (k < text.length && text[k] !== "\n") word = (word ?? "") + text[k];
    } else if (ch === "#" && word === null) {
      while (k + 1 < text.length && text[k + 1] !== "\n") k += 1;
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if ("\n;&|()`".includes(ch)) {
      endCommand();
    } else {
      word = (word ?? "") + ch;
    }
  }
  endCommand();
  return commands;
}

// The words before a command that are not the command: assignments (CI=true) and the shell's own words.
const LEADING = new Set(["!", "{", "if", "then", "elif", "else", "do", "time", "exec", "env"]);

function commandWords(words) {
  let k = 0;
  while (k < words.length && (LEADING.has(words[k]) || /^[A-Za-z_]\w*=/.test(words[k]))) {
    k += 1;
  }
  return words.slice(k);
}

// ---------------------------------------------------------------------------------------------------------------
// vitest: itself, a path to its bin or entry file, or a package spec (vitest@5).

const isVitest = (word) => /(?:^|\/)vitest(?:\.mjs|@[^/]*)?$/.test(word);

// Whether a vitest command line runs the contract project. vitest list and vitest init run no test, nor do --help
// and --version. --project (-p) is read as Vitest 5's --help gives it: * is a wildcard, !pattern excludes, and "a
// project runs if it matches no negated pattern and, when regular patterns are also given, matches at least one of
// them". With no --project, every project runs.
function vitestRunsContract(args) {
  if (["list", "init"].includes(args[0]) || args.some((arg) => /^(?:--help|-h|--version|-v)$/.test(arg))) {
    return false;
  }
  const patterns = [];
  args.forEach((arg, k) => {
    const flag = /^(?:--project|-p)(?:=(.*))?$/.exec(arg);
    if (flag !== null) patterns.push(flag[1] ?? args[k + 1] ?? "");
  });
  const negated = patterns.filter((pattern) => pattern.startsWith("!"));
  const regular = patterns.filter((pattern) => !pattern.startsWith("!"));
  if (negated.some((pattern) => wildcard(pattern.slice(1)).test(PROJECT))) return false;
  return regular.length === 0 || regular.some((pattern) => wildcard(pattern).test(PROJECT));
}

// ---------------------------------------------------------------------------------------------------------------
// npm: npm test (t, tst) and npm run (run-script, rum, urn) run a package.json script, npm exec (x) and npx run a
// command. npm's own flags come before "--"; the script's arguments come after it, or as plain words after its name.

const NPM_TEST = new Set(["test", "t", "tst"]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const NPM_EXEC = new Set(["exec", "x"]);
// npm flags whose value is the next word when it is not given as --flag=value.
const NPM_VALUE_FLAGS = new Set(["--workspace", "-w", "--prefix", "--loglevel", "--package"]);

/** { exec: words } for npm exec; { script, extra, workspaces, every } for a script run; null for anything else. */
function readNpm(args) {
  const words = [];
  const extra = [];
  const workspaces = [];
  let every = false;
  for (let k = 0; k < args.length; k += 1) {
    const flag = /^(-[^=]*)(?:=(.*))?$/.exec(args[k]);
    if (args[k] === "--") {
      extra.push(...args.slice(k + 1));
      break;
    } else if (flag === null) {
      words.push(args[k]);
      if (NPM_EXEC.has(words[0])) return { exec: args.slice(k + 1) };
    } else {
      let value = flag[2];
      if (value === undefined && NPM_VALUE_FLAGS.has(flag[1])) {
        k += 1;
        value = args[k];
      }
      if (flag[1] === "--workspace" || flag[1] === "-w") workspaces.push(value);
      if (flag[1] === "--workspaces" || flag[1] === "-ws") every = true;
    }
  }
  const [command, ...rest] = words;
  if (NPM_TEST.has(command)) return { script: "test", extra: [...rest, ...extra], workspaces, every };
  if (NPM_RUN.has(command) && rest.length > 0) {
    return { script: rest[0], extra: [...rest.slice(1), ...extra], workspaces, every };
  }
  return null;
}

// The package folders a script run runs in: the one it starts in, or the workspaces it names (--workspace takes a
// workspace's folder or its package name; --workspaces takes them all).
function packageDirs(call, dir) {
  if (call.workspaces.length === 0 && !call.every) return [dir];
  const folders = readPackage(REPO).workspaces ?? [];
  assert.ok(
    folders.every((folder) => !folder.includes("*")),
    "package.json's workspaces are folders",
  );
  const dirs = folders.map((folder) => path.join(REPO, folder));
  if (call.every) return dirs;
  return dirs.filter((where) =>
    call.workspaces.some((name) => path.resolve(REPO, name) === where || readPackage(where).name === name),
  );
}

// A script run, in each package it runs in: its pre script, the script with the arguments npm appends to it, then
// its post script. A name with a * stands for every script it matches.
function scriptRuns(call, dir, chain, seen) {
  const runs = [];
  for (const where of packageDirs(call, dir)) {
    const scripts = readPackage(where).scripts ?? {};
    const names = call.script.includes("*")
      ? Object.keys(scripts).filter((name) => wildcard(call.script).test(name))
      : [call.script];
    for (const name of names) {
      const key = `${where}#${name}`;
      // A script that runs itself would never end under npm; there is nothing more to find in it.
      if (seen.has(key)) continue;
      for (const part of [`pre${name}`, name, `post${name}`]) {
        if (typeof scripts[part] !== "string") continue;
        const commands = commandsOf(scripts[part]);
        if (part === name) commands.at(-1)?.push(...call.extra);
        runs.push(...runsOf(commands, where, chain, new Set([...seen, key])));
      }
    }
  }
  return runs;
}

/** The contract project's runs that commands start, each as its chain of commands, from the first to vitest's. */
function runsOf(commands, dir, chain, seen) {
  const runs = [];
  for (const words of commands.map(commandWords)) {
    if (words.length === 0) continue;
    const [command, ...args] = words;
    const here = [...chain, words.join(" ")];
    if (isVitest(command) || (command === "node" && isVitest(args[0] ?? ""))) {
      if (vitestRunsContract(command === "node" ? args.slice(1) : args)) runs.push(here);
    } else if (command === "npx" || command === "npm") {
      const call = command === "npx" ? { exec: args } : readNpm(args);
      if (call?.exec !== undefined) {
        const at = call.exec.findIndex((word) => isVitest(word));
        if (at !== -1 && vitestRunsContract(call.exec.slice(at + 1))) runs.push(here);
      } else if (call !== null) {
        runs.push(...scriptRuns(call, dir, here, seen));
      }
    }
  }
  return runs;
}

const runsContract = (script) => runsOf(commandsOf(script), REPO, [], new Set()).length > 0;

// ---------------------------------------------------------------------------------------------------------------
// The workflows' steps

/** Each run step of a workflow that runs the contract project: where it is, its runs, its job and its env. */
function contractSteps(file, doc) {
  const steps = [];
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    (job.steps ?? []).forEach((step, k) => {
      if (typeof step.run !== "string") return;
      const runs = runsOf(commandsOf(step.run), REPO, [], new Set());
      if (runs.length === 0) return;
      const where = `${file} > ${id} > ${step.name ?? `step ${k + 1}`}`;
      steps.push({ where, runs, job, env: { ...doc.env, ...job.env, ...step.env } });
    });
  }
  return steps;
}

/** What keeps a step's DATABASE_URL from reaching a PostGIS service of its job: [] when nothing does. */
function databaseProblems({ job, env }) {
  if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL === "") return ["no DATABASE_URL"];
  let target;
  try {
    target = new URL(env.DATABASE_URL);
  } catch {
    return ["its DATABASE_URL is not a URL (CI holds no secret, DL-024)"];
  }
  if (!["postgres:", "postgresql:"].includes(target.protocol)) {
    return ["its DATABASE_URL is not a postgres:// URL"];
  }
  if (job.container !== undefined) {
    return ["its job runs in a container, where its services are not on localhost"];
  }
  if (!["localhost", "127.0.0.1"].includes(target.hostname)) {
    return ["its DATABASE_URL's host is not localhost, where the job's services are published"];
  }
  const port = target.port || "5432";
  const published = (service) =>
    (service?.ports ?? []).some((mapping) => {
      const [outside, inside] = String(mapping).split(":");
      return inside !== undefined && outside === port;
    });
  const found = Object.entries(job.services ?? {}).find(([, service]) => published(service));
  if (found === undefined) return [`no service of its job is published on port ${port}`];
  const [name, service] = found;
  const own = service.env ?? {};
  const problems = [];
  if (!/^postgis\/postgis:/.test(service.image ?? "")) {
    problems.push(`its ${name} service is not postgis/postgis`);
  }
  if (!/--health-cmd "pg_isready /.test(service.options ?? "")) {
    problems.push(`its ${name} service has no pg_isready health check`);
  }
  if (decodeURIComponent(target.username) !== own.POSTGRES_USER) {
    problems.push(`its DATABASE_URL's user is not the ${name} service's`);
  }
  if (decodeURIComponent(target.password) !== own.POSTGRES_PASSWORD) {
    problems.push(`its DATABASE_URL's password is not the ${name} service's`);
  }
  if (target.pathname !== `/${own.POSTGRES_DB}`) {
    problems.push(`its DATABASE_URL's database is not the ${name} service's`);
  }
  return problems;
}

/** Each contract-running step of a workflow whose DATABASE_URL does not reach a PostGIS service of its job. */
function problemsOf(file, doc) {
  return contractSteps(file, doc).flatMap((step) =>
    databaseProblems(step).map(
      (problem) => `${step.where}: ${problem} (it runs ${step.runs[0].join(" > ")})`,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------

test("every workflow step that runs the contract project gets a DATABASE_URL to a PostGIS service of its job", () => {
  assert.ok(
    FILES.includes("ci.yml") && FILES.includes("merge-check.yml"),
    `the workflows: ${FILES.join(", ")}`,
  );
  assert.deepEqual(
    FILES.flatMap((file) => problemsOf(file, workflow(file))),
    [],
  );
});

test("the steps that run it today: npm test in ci.yml's checks job and in merge-check.yml's merge-check job", () => {
  const found = FILES.flatMap((file) => contractSteps(file, workflow(file)));
  assert.deepEqual(
    found.map((step) => step.where),
    [`ci.yml > checks > ${TESTS_STEP}`, `merge-check.yml > merge-check > ${TESTS_STEP}`],
  );
  for (const { where, runs } of found) {
    assert.deepEqual(
      runs.map((chain) => chain[0]),
      ["npm test"],
      where,
    );
    assert.match(runs[0].at(-1), /^vitest run .*--project contract\b/, where);
  }
});

test("the reader finds the contract project behind vitest, npx, npm exec and npm's scripts, and nowhere else", () => {
  const runs = [
    "npm test",
    "npm t",
    "npm run test -- tests/contract",
    "npm run test:contract",
    "npm run test:contract -- data-access",
    "npm --silent run test:contract",
    "npm run test:unit -- --project contract",
    "npm run test:${{ matrix.project }}",
    'npm run "test:$PROJECT"',
    "set -euo pipefail\nnpm test 2>&1 | tee test.log",
    "CI=true npm test",
    "if ! npm test; then\n  exit 1\nfi",
    "npx vitest",
    "npx vitest run --project contract",
    "npx vitest run --project=contract tests/contract",
    "npx --yes vitest@5 run -p contract",
    "npm exec -- vitest run",
    "vitest run",
    "node_modules/.bin/vitest run --project 'cont*'",
    "node node_modules/vitest/vitest.mjs run",
    "npx vitest run --project '!unit'",
  ];
  const others = [
    "npm ci --no-audit --no-fund",
    "npm run contracts:types",
    "npm run contracts:check",
    "npm run test:integration",
    "npm run test:e2e",
    'npm run test:parity -- --shard="${{ matrix.shard }}/$SHARD_COUNT"',
    'node --test "infra/ci/*.test.mjs"',
    "npx vitest run --project unit --project workers",
    "npx vitest run --project '!contract'",
    "npx vitest run --project contract --project '!cont*'",
    "npx vitest list --project contract",
    "npx vitest --version",
    "echo npm test",
    'echo "npm test" >> "$GITHUB_STEP_SUMMARY"',
    "# npm test",
    "npm run no-such-script",
  ];
  for (const script of runs) assert.ok(runsContract(script), `runs the contract project: ${script}`);
  for (const script of others) assert.ok(!runsContract(script), `does not run it: ${script}`);
});

test("the check fails on the old ci.yml, whose DATABASE_URL reached its CI script tests step alone", () => {
  const doc = workflow("ci.yml");
  const job = doc.jobs.checks;
  const scripts = job.steps.find((step) => step.run === 'node --test "infra/ci/*.test.mjs"');
  assert.ok(scripts, "ci.yml runs the CI script tests");
  const url = job.env?.DATABASE_URL;
  assert.match(url ?? "", /^postgres:\/\//, "ci.yml's checks job sets the DATABASE_URL");
  // ci.yml before T-1191 (main at 3ed41e9): the URL in that step's env, and none in the job's.
  delete job.env.DATABASE_URL;
  scripts.env = { DATABASE_URL: url };
  const problems = problemsOf("ci.yml", doc);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(
    problems[0],
    /^ci\.yml > checks > Tests \(unit, workers, contract\): no DATABASE_URL \(it runs npm test > vitest run /,
  );
});

test("the check fails on copies of the workflows with the URL, the service or a step changed", () => {
  const checks = (doc) => doc.jobs.checks;
  const withUrl = (url) => (doc) => {
    checks(doc).env.DATABASE_URL = url;
  };
  const tests = `ci.yml > checks > ${TESTS_STEP}`;
  const copies = [
    {
      file: "ci.yml",
      name: "without a DATABASE_URL",
      where: tests,
      change: (doc) => {
        delete checks(doc).env.DATABASE_URL;
      },
    },
    {
      file: "ci.yml",
      name: "with the tests step's own URL on another database",
      where: tests,
      change: (doc) => {
        checks(doc).steps.find((step) => step.name === TESTS_STEP).env = {
          DATABASE_URL: "postgres://rosie:rosie@localhost:5432/other",
        };
      },
    },
    {
      file: "ci.yml",
      name: "with the URL on another port",
      where: tests,
      change: withUrl("postgres://rosie:rosie@localhost:5433/rosie"),
    },
    {
      file: "ci.yml",
      name: "with the URL on another host",
      where: tests,
      change: withUrl("postgres://rosie:rosie@db.internal:5432/rosie"),
    },
    {
      file: "ci.yml",
      name: "with another user in the URL",
      where: tests,
      change: withUrl("postgres://other:rosie@localhost:5432/rosie"),
    },
    {
      file: "ci.yml",
      name: "with another password in the URL",
      where: tests,
      change: withUrl("postgres://rosie:other@localhost:5432/rosie"),
    },
    {
      file: "ci.yml",
      name: "with a secret for the URL",
      where: tests,
      change: withUrl("${{ secrets.DATABASE_URL }}"),
    },
    {
      file: "ci.yml",
      name: "without the service",
      where: tests,
      change: (doc) => {
        delete checks(doc).services;
      },
    },
    {
      file: "ci.yml",
      name: "with a plain postgres image",
      where: tests,
      change: (doc) => {
        checks(doc).services.postgres.image = "postgres:17";
      },
    },
    {
      file: "ci.yml",
      name: "without the service's health check",
      where: tests,
      change: (doc) => {
        checks(doc).services.postgres.options = "--health-interval 5s";
      },
    },
    {
      file: "ci.yml",
      name: "with the job in a container",
      where: tests,
      change: (doc) => {
        checks(doc).container = "node:22";
      },
    },
    {
      file: "ci.yml",
      name: "with a new job that runs npm run test:contract and has no database",
      where: "ci.yml > contract > Contract tests",
      change: (doc) => {
        doc.jobs.contract = {
          "runs-on": "ubuntu-latest",
          steps: [{ name: "Contract tests", run: "npm run test:contract" }],
        };
      },
    },
    {
      file: "merge-check.yml",
      name: "without the merge-check job's DATABASE_URL",
      where: `merge-check.yml > merge-check > ${TESTS_STEP}`,
      change: (doc) => {
        delete doc.jobs["merge-check"].env.DATABASE_URL;
      },
    },
    {
      file: "merge-check.yml",
      name: "with npm test as the shard job's last step (that job has no database)",
      where: "merge-check.yml > parity-shard > Parity shards (this job's share of the parity files)",
      change: (doc) => {
        doc.jobs["parity-shard"].steps.at(-1).run = "npm test";
      },
    },
  ];
  for (const { file, name, where, change } of copies) {
    const doc = workflow(file);
    assert.deepEqual(problemsOf(file, doc), [], `${file} as it stands passes`);
    change(doc);
    const problems = problemsOf(file, doc);
    assert.ok(
      problems.some((problem) => problem.startsWith(`${where}: `)),
      `a copy of ${file} ${name} fails at ${where}: ${problems.join("; ")}`,
    );
  }
});
