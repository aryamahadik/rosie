// Tests for infra/ci/test-guard.mjs, run in ci.yml by `node --test "infra/ci/*.test.mjs"`.
// Unit tests use inline fixture sources. End-to-end tests build throwaway git repositories in the system temp
// folder (never the real repository) with a fake origin/main, and run the guard as CI does.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { collectTests, compareTests, extractTests, isTestFile, parseQuarantine } from "./test-guard.mjs";

const GUARD = fileURLToPath(new URL("./test-guard.mjs", import.meta.url));

const statuses = (source, file) =>
  extractTests(source, file).tests.map((test) => `${test.status} ${test.id}`);
const collect = (files) => collectTests(Object.entries(files));

describe("extractTests", () => {
  it("names each test by its file, describe blocks and title", () => {
    const source = `
      import { describe, it, test } from "vitest";
      describe("health", () => {
        it("returns 200", () => {});
        describe("trace id", () => {
          test("is echoed", () => {});
        });
      });
      it("top level", () => {});
    `;
    assert.deepEqual(statuses(source, "src/a.test.ts"), [
      "run src/a.test.ts > health > returns 200",
      "run src/a.test.ts > health > trace id > is echoed",
      "run src/a.test.ts > top level",
    ]);
  });

  it("reads skip, todo and only in their Vitest, node:test and Playwright spellings", () => {
    const source = `
      it.skip("a", () => {});
      xit("b", () => {});
      test.todo("c");
      it("d", { skip: true }, () => {});
      test("e", { todo: "later" }, () => {});
      it("f", { skip: false }, () => {});
      test.skipIf(process.env.CI)("g", () => {});
      it.runIf(hasDatabase)("h", () => {});
      test.fixme("i", async () => {});
      describe.skip("old", () => { it("j", () => {}); it.todo("k"); });
      describe.todo("soon", () => { it("l", () => {}); });
      it.only("m", () => {});
      fdescribe("n", () => { it("o", () => {}); });
    `;
    const found = extractTests(source, "x.test.ts");
    assert.deepEqual(
      found.tests.map((test) => `${test.status} ${test.id.replace("x.test.ts > ", "")}`),
      [
        "skip a",
        "skip b",
        "todo c",
        "skip d",
        "todo e",
        "run f",
        "skip g",
        "skip h",
        "skip i",
        "skip old > j",
        "todo old > k",
        "todo soon > l",
        "run m",
        "run n > o",
      ],
    );
    assert.deepEqual(
      found.only.map((marker) => marker.id),
      ["x.test.ts > m", "x.test.ts > n"],
    );
  });

  it("ignores test code in comments, strings, templates and regular expressions, and member calls", () => {
    const source = [
      '// it("comment", () => {});',
      '/* test("block comment", () => {}); */',
      "const quoted = \"it('string', () => {})\";",
      'const template = `it("template") ${it("inside")}`;',
      'const pattern = /it\\("regex"\\)/;',
      'pattern.test("value");',
      "t.test('subtest', () => {});",
      "function test(name) { return name; }",
      'it("real", () => { expect(/\\d+/.test("1")).toBe(true); });',
    ].join("\n");
    assert.deepEqual(statuses(source, "c.test.ts"), ["run c.test.ts > real"]);
  });

  it("counts a table-driven test once and ignores run-time calls inside a test body", () => {
    const source = `
      it.each([1, 2, 3])("row %s", (n) => {});
      test.each\`
        a | b
        1 | 2
      \`("table $a", () => {});
      it.each<[number]>([[1]])("typed %s", () => {});
      test("page", async ({ page }) => {
        test.skip(page.isClosed(), "skipped at run time");
        await test.step("inner", async () => {});
      });
      test.beforeEach(() => {});
      test.describe("group", () => { test("x", () => {}); });
    `;
    assert.deepEqual(statuses(source, "e.spec.ts"), [
      "run e.spec.ts > row %s",
      "run e.spec.ts > table $a",
      "run e.spec.ts > typed %s",
      "run e.spec.ts > page",
      "run e.spec.ts > group > x",
    ]);
  });

  it("numbers repeated names so that each test keeps a name of its own", () => {
    const source = 'it("same", () => {});\nit("same", () => {});';
    assert.deepEqual(statuses(source, "d.test.ts"), ["run d.test.ts > same", "run d.test.ts > same #2"]);
  });

  it("knows which files hold tests", () => {
    assert.equal(isTestFile("runtime/src/index.worker.test.ts"), true);
    assert.equal(isTestFile("infra/ci/guard.test.mjs"), true);
    assert.equal(isTestFile("tests/e2e/booking.spec.ts"), true);
    assert.equal(isTestFile("web/src/App.test.tsx"), true);
    assert.equal(isTestFile("runtime/src/index.ts"), false);
    assert.equal(isTestFile("node_modules/pkg/a.test.js"), false);
    assert.equal(isTestFile("docs/testing.md"), false);
  });
});

describe("parseQuarantine", () => {
  it("reads rows with a test, a task id and who allowed it, and ignores rows that lack one", () => {
    const markdown = [
      "# Quarantined and removed tests",
      "",
      "| Test | Task | Allowed by | Reason |",
      "|---|---|---|---|",
      "| `src/a.test.ts > health > returns 200` | T-041 | QA quarantine (7.8) | flaky |",
      "| `src/b.test.ts` | T-090 | contract-removal task (6.4) | contract v1 removed |",
      "| `src/c.test.ts > x` |  | QA | no task id |",
      "| `src/d.test.ts > y` | T-007 | the builder | not one of the three |",
    ].join("\n");
    const { entries, problems } = parseQuarantine(markdown);
    assert.deepEqual(
      entries.filter((entry) => entry.valid).map((entry) => [entry.test, entry.task]),
      [
        ["src/a.test.ts > health > returns 200", "T-041"],
        ["src/b.test.ts", "T-090"],
      ],
    );
    assert.deepEqual(
      problems.map((problem) => problem.line),
      [7, 8],
    );
  });

  it("returns nothing for a missing or empty file", () => {
    assert.deepEqual(parseQuarantine(""), { entries: [], problems: [] });
  });
});

describe("compareTests", () => {
  const base = collect({
    "src/a.test.ts":
      'describe("health", () => { it("returns 200", () => {}); it("echoes the trace id", () => {}); });',
    "src/b.test.ts": 'it("old skipped", { skip: true }, () => {});',
  });
  const quarantine = (rows) =>
    parseQuarantine(["| Test | Task | Allowed by |", "|---|---|---|", ...rows].join("\n"));

  it("passes an unchanged branch", () => {
    const result = compareTests(base, base);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.counts.branch, { tests: 3, skipped: 1, todo: 0, only: 0 });
  });

  it("fails a branch with fewer tests, unless the removed test is quarantined", () => {
    const branch = collect({
      "src/a.test.ts": 'describe("health", () => { it("returns 200", () => {}); });',
      "src/b.test.ts": 'it("old skipped", { skip: true }, () => {});',
    });
    const failed = compareTests(base, branch);
    assert.deepEqual(
      failed.errors.map((error) => [error.kind, error.id]),
      [["removed", "src/a.test.ts > health > echoes the trace id"]],
    );
    const allowed = compareTests(
      base,
      branch,
      quarantine(["| `src/a.test.ts > health > echoes the trace id` | T-041 | QA quarantine (7.8) |"]),
    );
    assert.deepEqual(allowed.errors, []);
    assert.equal(allowed.allowed.length, 1);
  });

  it("lets a file or describe row cover every test under it, but never a row without a task id", () => {
    const branch = collect({ "src/b.test.ts": 'it("old skipped", { skip: true }, () => {});' });
    assert.deepEqual(
      compareTests(base, branch, quarantine(["| `src/a.test.ts` | T-090 | contract removal |"])).errors,
      [],
    );
    assert.deepEqual(
      compareTests(base, branch, quarantine(["| `src/a.test.ts > health` | T-090 | architect ruling |"]))
        .errors,
      [],
    );
    assert.equal(compareTests(base, branch, quarantine(["| `src/a.test.ts` |  | QA |"])).errors.length, 2);
  });

  it("reports a renamed test without failing when the number of tests stays the same", () => {
    const branch = collect({
      "src/a.test.ts":
        'describe("health", () => { it("returns 200", () => {}); it("echoes x-trace-id", () => {}); });',
      "src/b.test.ts": 'it("old skipped", { skip: true }, () => {});',
    });
    const result = compareTests(base, branch);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.notices.map((notice) => notice.id),
      ["src/a.test.ts > health > echoes the trace id"],
    );
  });

  it("fails a newly skipped test and a new todo test, unless quarantined", () => {
    const branch = collect({
      "src/a.test.ts":
        'describe("health", () => { it("returns 200", () => {}); it.skip("echoes the trace id", () => {}); it.todo("later"); });',
      "src/b.test.ts": 'it("old skipped", { skip: true }, () => {});',
    });
    assert.deepEqual(
      compareTests(base, branch).errors.map((error) => error.message),
      [
        '"src/a.test.ts > health > echoes the trace id" is skipped here but runs on origin/main',
        '"src/a.test.ts > health > later" is a new todo test',
      ],
    );
    const allowed = compareTests(
      base,
      branch,
      quarantine(["| `src/a.test.ts > health` | T-050 | QA quarantine |"]),
    );
    assert.deepEqual(allowed.errors, []);
  });

  it("passes a test that was already skipped on main, and a test that runs again", () => {
    const branch = collect({
      "src/a.test.ts":
        'describe("health", () => { it("returns 200", () => {}); it("echoes the trace id", () => {}); });',
      "src/b.test.ts": 'it("old skipped", () => {});',
    });
    assert.deepEqual(compareTests(base, base).errors, []);
    assert.deepEqual(compareTests(base, branch).errors, []);
  });

  it("never allows a new .only, even when quarantine lists the test", () => {
    const branch = collect({
      "src/a.test.ts":
        'describe("health", () => { it.only("returns 200", () => {}); it("echoes the trace id", () => {}); });',
      "src/b.test.ts": 'it("old skipped", { skip: true }, () => {});',
    });
    const result = compareTests(base, branch, quarantine(["| `src/a.test.ts` | T-041 | QA quarantine |"]));
    assert.deepEqual(
      result.errors.map((error) => error.kind),
      ["only"],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------
// End to end, in throwaway git repositories

function gitEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && !key.startsWith("GITHUB_")) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Guard Test",
    GIT_AUTHOR_EMAIL: "guard-test@example.invalid",
    GIT_COMMITTER_NAME: "Guard Test",
    GIT_COMMITTER_EMAIL: "guard-test@example.invalid",
    ...extra,
  };
}

function tempRepo(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rosie-test-guard-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  return {
    git,
    write(file, content) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    markOriginMain: () => git("update-ref", "refs/remotes/origin/main", "HEAD"),
    guard: (args = [], extra = {}) =>
      spawnSync(process.execPath, [GUARD, ...args], {
        cwd: dir,
        env: { ...env, ...extra },
        encoding: "utf8",
      }),
  };
}

const TWO_TESTS = `import { describe, it } from "vitest";
describe("health", () => {
  it("returns 200", () => {});
  it("echoes the trace id", () => {});
});
`;
const ONE_TEST = `import { describe, it } from "vitest";
describe("health", () => {
  it("returns 200", () => {});
});
`;

describe("test guard, end to end", () => {
  it("passes a branch that adds a test, including an uncommitted file", (t) => {
    const repo = tempRepo(t);
    repo.write("src/a.test.ts", TWO_TESTS);
    repo.commit("base");
    repo.markOriginMain();
    repo.git("switch", "-q", "-c", "task/T-001");
    repo.write("src/b.test.ts", 'import { it } from "vitest";\nit("is new", () => {});\n');
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /tests\s+2 -> 3/);
    assert.match(run.stdout, /test guard: passed/);
  });

  it("fails a working tree that removes a test, and names the test and the fix", (t) => {
    const repo = tempRepo(t);
    repo.write("src/a.test.ts", TWO_TESTS);
    repo.commit("base");
    repo.markOriginMain();
    repo.git("switch", "-q", "-c", "task/T-002");
    repo.write("src/a.test.ts", ONE_TEST);
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /FAIL src\/a\.test\.ts {2}"src\/a\.test\.ts > health > echoes the trace id" is on origin\/main/,
    );
    assert.match(
      run.stdout,
      /\| `src\/a\.test\.ts > health > echoes the trace id` \| T-xxx \| QA quarantine \(7\.8\) \|/,
    );
    assert.match(run.stdout, /test guard: FAILED \(1 problem\)/);
  });

  it("passes the removal once QA lists the test in tests/QUARANTINE.md", (t) => {
    const repo = tempRepo(t);
    repo.write("src/a.test.ts", TWO_TESTS);
    repo.commit("base");
    repo.markOriginMain();
    repo.git("switch", "-q", "-c", "task/T-003");
    repo.write("src/a.test.ts", ONE_TEST);
    repo.write(
      "tests/QUARANTINE.md",
      [
        "| Test | Task | Allowed by | Reason |",
        "|---|---|---|---|",
        "| `src/a.test.ts > health > echoes the trace id` | T-003 | QA quarantine (7.8) | flaky, fix task T-004 |",
        "",
      ].join("\n"),
    );
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /allowed by tests\/QUARANTINE\.md line 3 \(T-003, QA quarantine \(7\.8\)\)/);
  });

  it("does not blame a branch for tests that main added after the branch was cut", (t) => {
    const repo = tempRepo(t);
    repo.write("src/a.test.ts", TWO_TESTS);
    repo.commit("base");
    repo.markOriginMain();
    repo.git("switch", "-q", "-c", "task/T-005");
    repo.write("README.md", "branch work\n");
    repo.commit("branch work");
    repo.git("switch", "-q", "main");
    repo.write(
      "src/c.test.ts",
      'import { it } from "vitest";\nit("main 1", () => {});\nit("main 2", () => {});\n',
    );
    repo.commit("main moves on");
    repo.markOriginMain();
    repo.git("switch", "-q", "task/T-005");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /merge-base of HEAD and origin\/main/);
  });

  it("compares with another ref given by --base", (t) => {
    const repo = tempRepo(t);
    repo.write("src/a.test.ts", TWO_TESTS);
    repo.commit("base");
    repo.git("switch", "-q", "-c", "task/T-006");
    repo.write("src/a.test.ts", ONE_TEST);
    const run = repo.guard(["--base", "main"]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /is on main but not on this branch/);
  });

  it("stops with exit code 2 when origin/main is missing", (t) => {
    const repo = tempRepo(t);
    repo.write("src/a.test.ts", TWO_TESTS);
    repo.commit("base");
    const run = repo.guard();
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /origin\/main was not found/);
  });

  it("writes GitHub annotations when it runs in GitHub Actions", (t) => {
    const repo = tempRepo(t);
    repo.write("src/a.test.ts", TWO_TESTS);
    repo.commit("base");
    repo.markOriginMain();
    repo.git("switch", "-q", "-c", "task/T-007");
    repo.write("src/a.test.ts", TWO_TESTS.replace('it("returns 200"', 'it.skip("returns 200"'));
    const run = repo.guard([], { GITHUB_ACTIONS: "true" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /^::error file=src\/a\.test\.ts,line=3,title=Test guard::"src\/a\.test\.ts > health > returns 200" is skipped here/m,
    );
  });
});
