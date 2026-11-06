#!/usr/bin/env node
// Test guard: `npm run guard:tests` (factory spec section 3; build prompt 5.2, 7.8 and 7.9).
// ES module, so strict mode is on. No dependencies; it runs git itself.
//
// It compares the tests on this branch (the working tree) with the tests at the merge-base of HEAD and
// origin/main, so a branch that is only behind main is not blamed for tests main added since. It fails when
// the branch:
//   1. has fewer tests, unless each test it removes is listed in tests/QUARANTINE.md (then every name that is
//      gone counts as removed, a test renamed on the same branch included);
//   2. skips, or marks todo, a test that runs on origin/main, or adds a new skipped or todo test, unless
//      that test is listed in tests/QUARANTINE.md;
//   3. has more `.only` markers than origin/main (never allowed).
// A test renamed or moved while the number of tests stays the same is reported, not failed.
//
// How it counts: it reads the test files (*.test.* and *.spec.*) and finds the it/test/describe calls in
// their Vitest, node:test and Playwright spellings, without running anything. A test is named
// "<file> > <describe> > ... > <title>". Tests made at run time (it.each rows, loops) count once.
//
// tests/QUARANTINE.md belongs to QA. The guard reads a Markdown table whose header has a Test, a Task and an
// "Allowed by" column. A row names one test, or a file or a describe block (it then covers every test in it):
//   | Test | Task | Allowed by | Reason |
//   |---|---|---|---|
//   | `runtime/src/index.worker.test.ts > health > echoes the trace id` | T-041 | QA quarantine (7.8) | flaky |
// Task holds the task id (T-xxx). Allowed by names QA (quarantine, 7.8), the architect (ruling, 6.6) or a
// contract-removal task (6.4). A row without both is ignored, with a notice.
//
// Usage: node infra/ci/test-guard.mjs [--base <ref>]      (default ref: origin/main)
// Exit code: 0 passed, 1 failed, 2 could not run (for example origin/main is missing).

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = "origin/main";
const QUARANTINE_FILE = "tests/QUARANTINE.md";
const TITLE = "Test guard";
const MAX_LISTED = 20;
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const USAGE = "Usage: node infra/ci/test-guard.mjs [--base <ref>]   (default ref: origin/main)";

/** Stops the guard from running at all (exit code 2), as opposed to a failed check (exit code 1). */
export class GuardError extends Error {}

export function isTestFile(file) {
  return TEST_FILE.test(file) && !file.split("/").includes("node_modules");
}

// ---------------------------------------------------------------------------------------------------------
// Reading JavaScript and TypeScript just enough to find test declarations. Comments, strings, template
// literals and regular expressions are skipped, so test code quoted inside a string is never counted.

const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
  ["0", "\0"],
]);
const WORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const OPENERS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

const isIdentStart = (ch) => /[A-Za-z_$]/.test(ch) || ch > "\u007f";
const isIdentPart = (ch) => /[\w$]/.test(ch) || ch > "\u007f";

function countNewlines(src, from, to) {
  let count = 0;
  for (let k = from; k < to; k += 1) if (src.charCodeAt(k) === 10) count += 1;
  return count;
}

// A quoted string. An unterminated one ends at the line end, so a stray quote (JSX text) costs one line.
function readQuoted(src, start, quote) {
  let k = start + 1;
  let value = "";
  let lines = 0;
  while (k < src.length) {
    const ch = src[k];
    if (ch === quote) return { value, end: k + 1, lines };
    if (ch === "\n") return { value, end: k, lines };
    if (ch === "\\") {
      const next = src[k + 1];
      if (next === "\n") {
        lines += 1;
        k += 2;
        continue;
      }
      if (next === "\r" && src[k + 2] === "\n") {
        lines += 1;
        k += 3;
        continue;
      }
      value += ESCAPES.get(next) ?? next ?? "";
      k += 2;
      continue;
    }
    value += ch;
    k += 1;
  }
  return { value, end: k, lines };
}

// Returns the index after the closing backtick; ${...} parts are skipped as a whole.
function skipTemplate(src, start) {
  let k = start + 1;
  while (k < src.length) {
    const ch = src[k];
    if (ch === "\\") k += 2;
    else if (ch === "`") return k + 1;
    else if (ch === "$" && src[k + 1] === "{") k = skipTemplateExpression(src, k + 2);
    else k += 1;
  }
  return src.length;
}

function skipTemplateExpression(src, start) {
  let depth = 1;
  let k = start;
  while (k < src.length) {
    const ch = src[k];
    if (ch === "'" || ch === '"') {
      k = readQuoted(src, k, ch).end;
    } else if (ch === "`") {
      k = skipTemplate(src, k);
    } else if (ch === "/" && src[k + 1] === "/") {
      while (k < src.length && src[k] !== "\n") k += 1;
    } else if (ch === "/" && src[k + 1] === "*") {
      const close = src.indexOf("*/", k + 2);
      k = close === -1 ? src.length : close + 2;
    } else {
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) return k + 1;
      }
      k += 1;
    }
  }
  return src.length;
}

function regexCanStart(previous) {
  if (previous === undefined) return true;
  if (previous.type === "ident") return WORDS_BEFORE_REGEX.has(previous.value);
  if (previous.type === "punct") return previous.value !== ")" && previous.value !== "]";
  return false;
}

// Returns the index after a regular expression literal, or -1 when there is none on this line.
function skipRegex(src, start) {
  let k = start + 1;
  let inClass = false;
  while (k < src.length) {
    const ch = src[k];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") {
      k += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      k += 1;
      while (k < src.length && /[A-Za-z]/.test(src[k])) k += 1;
      return k;
    }
    k += 1;
  }
  return -1;
}

export function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  if (src.startsWith("#!")) {
    while (i < n && src[i] !== "\n") i += 1;
  }
  const add = (type, value, start, startLine) => tokens.push({ type, value, start, end: i, line: startLine });
  while (i < n) {
    const ch = src[i];
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? n : close + 2;
      line += countNewlines(src, i, stop);
      i = stop;
      continue;
    }
    const start = i;
    const startLine = line;
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(src, i, ch);
      i = quoted.end;
      line += quoted.lines;
      add("string", quoted.value, start, startLine);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(src, i);
      line += countNewlines(src, start, i);
      add("template", src.slice(start + 1, Math.max(start + 1, i - 1)), start, startLine);
      continue;
    }
    if (isIdentStart(ch)) {
      i += 1;
      while (i < n && isIdentPart(src[i])) i += 1;
      add("ident", src.slice(start, i), start, startLine);
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      i += 1;
      while (i < n && /[\w.]/.test(src[i])) i += 1;
      add("number", src.slice(start, i), start, startLine);
      continue;
    }
    if (ch === "/" && regexCanStart(tokens[tokens.length - 1])) {
      const end = skipRegex(src, i);
      if (end !== -1) {
        i = end;
        add("regex", src.slice(start, i), start, startLine);
        continue;
      }
    }
    i += 1;
    add("punct", ch, start, startLine);
  }
  return tokens;
}

// For each (, [ or { token, the index of its partner (and back); -1 when unmatched.
function matchBrackets(tokens) {
  const partner = new Array(tokens.length).fill(-1);
  const stack = [];
  tokens.forEach((token, k) => {
    if (token.type !== "punct") return;
    if (OPENERS.has(token.value)) {
      stack.push(k);
      return;
    }
    if (token.value !== ")" && token.value !== "]" && token.value !== "}") return;
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (OPENERS.get(tokens[stack[s]].value) === token.value) {
        partner[stack[s]] = k;
        partner[k] = stack[s];
        stack.length = s;
        break;
      }
    }
  });
  return partner;
}

const isPunct = (token, value) => token !== undefined && token.type === "punct" && token.value === value;

// it/test declare tests, describe/suite declare groups; x* skip, f* focus (only).
const CALLEES = new Map([
  ["it", { kind: "test" }],
  ["test", { kind: "test" }],
  ["describe", { kind: "suite" }],
  ["suite", { kind: "suite" }],
  ["xit", { kind: "test", skip: true }],
  ["xtest", { kind: "test", skip: true }],
  ["xdescribe", { kind: "suite", skip: true }],
  ["fit", { kind: "test", only: true }],
  ["fdescribe", { kind: "suite", only: true }],
]);
// Modifiers that keep a call a declaration without changing whether it runs.
const NEUTRAL_MODIFIERS = new Set([
  "each",
  "for",
  "concurrent",
  "sequential",
  "shuffle",
  "fails",
  "serial",
  "parallel",
]);
// Modifiers that take their own argument list before the declaration's: it.each(rows)("name", fn).
const MODIFIERS_WITH_ARGS = new Set(["each", "for", "skipIf", "runIf"]);
// A callee right after one of these is not a test call: obj.test(), function test(), new test().
const NOT_A_CALL_AFTER = new Set([".", "function", "class", "new"]);
const FALSY_WORDS = new Set(["false", "undefined", "null"]);

function skipTypeArguments(tokens, k) {
  if (!isPunct(tokens[k], "<")) return k;
  let depth = 0;
  for (let j = k; j < tokens.length && j < k + 200; j += 1) {
    if (isPunct(tokens[j], "<")) depth += 1;
    if (isPunct(tokens[j], ">")) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return k;
}

// Top-level arguments between tokens[open] = "(" and tokens[close] = ")", as [first, last] token ranges.
function splitArguments(tokens, open, close, partner) {
  const args = [];
  let first = open + 1;
  let k = open + 1;
  while (k < close) {
    const token = tokens[k];
    if (token.type === "punct" && OPENERS.has(token.value)) {
      k = partner[k] === -1 ? close : partner[k] + 1;
      continue;
    }
    if (isPunct(token, ",")) {
      if (k > first) args.push([first, k - 1]);
      first = k + 1;
    }
    k += 1;
  }
  if (close > first) args.push([first, close - 1]);
  return args;
}

// Reads { skip: true }, { todo: "why" }, { only: true } options (node:test, Vitest). A plain falsy value
// keeps the test running; anything else (a condition) counts as set.
function readOptions(tokens, open, close, partner, flags) {
  let k = open + 1;
  while (k < close) {
    const token = tokens[k];
    if (token.type === "punct" && OPENERS.has(token.value)) {
      k = partner[k] === -1 ? close : partner[k] + 1;
      continue;
    }
    const isKey =
      token.type === "ident" &&
      (token.value === "skip" || token.value === "todo" || token.value === "only") &&
      (isPunct(tokens[k - 1], "{") || isPunct(tokens[k - 1], ",")) &&
      (isPunct(tokens[k + 1], ":") || isPunct(tokens[k + 1], ",") || isPunct(tokens[k + 1], "}"));
    if (isKey) {
      let on = true;
      if (isPunct(tokens[k + 1], ":")) {
        const value = tokens[k + 2];
        const after = tokens[k + 3];
        const falsy =
          value !== undefined &&
          ((value.type === "ident" && FALSY_WORDS.has(value.value)) ||
            (value.type === "number" && Number(value.value) === 0) ||
            ((value.type === "string" || value.type === "template") && value.value === ""));
        if (falsy && (after === undefined || isPunct(after, ",") || isPunct(after, "}"))) on = false;
      }
      if (on) flags[token.value] = true;
    }
    k += 1;
  }
}

function argumentTitle(src, tokens, [first, last]) {
  const token = tokens[first];
  if (first === last && (token.type === "string" || token.type === "template")) return token.value;
  if (token.type === "punct" && token.value === "(") return "<anonymous>";
  if (token.type === "ident" && (token.value === "async" || token.value === "function")) return "<anonymous>";
  return src.slice(token.start, tokens[last].end).slice(0, 120);
}

// Parses a declaration starting at tokens[k] (a callee name), or returns null when it is not one.
function parseDeclaration(src, tokens, k, partner) {
  const callee = CALLEES.get(tokens[k].value);
  let kind = callee.kind;
  const flags = { skip: Boolean(callee.skip), todo: false, only: Boolean(callee.only) };
  let j = k + 1;
  for (;;) {
    if (isPunct(tokens[j], "(")) break;
    if (!(isPunct(tokens[j], ".") && tokens[j + 1]?.type === "ident")) return null;
    const name = tokens[j + 1].value;
    j += 2;
    if (name === "describe" && tokens[k].value === "test" && kind === "test") {
      kind = "suite"; // Playwright: test.describe(...)
      continue;
    }
    if (name === "skip" || name === "fixme" || name === "skipIf" || name === "runIf") flags.skip = true;
    else if (name === "todo") flags.todo = true;
    else if (name === "only") flags.only = true;
    else if (!NEUTRAL_MODIFIERS.has(name)) return null; // hooks, test.step, test.extend, test.use, ...
    if (MODIFIERS_WITH_ARGS.has(name)) {
      j = skipTypeArguments(tokens, j);
      if (tokens[j]?.type === "template") {
        j += 1; // it.each`table`
      } else if (isPunct(tokens[j], "(") && partner[j] !== -1) {
        j = partner[j] + 1;
      } else {
        return null;
      }
    }
  }
  const open = j;
  const close = partner[open] === -1 ? tokens.length - 1 : partner[open];
  const args = splitArguments(tokens, open, close, partner);
  if (args.length === 0) return null; // test() with no arguments is not a declaration (a method, say)
  let title = argumentTitle(src, tokens, args[0]);
  let optionArgs = args.slice(1);
  if (isPunct(tokens[args[0][0]], "{")) {
    title = "<anonymous>";
    optionArgs = args;
  }
  for (const [first] of optionArgs) {
    if (isPunct(tokens[first], "{") && partner[first] !== -1) {
      readOptions(tokens, first, partner[first], partner, flags);
    }
  }
  return { kind, flags, close, title: title.replace(/\s+/g, " ").trim(), line: tokens[k].line };
}

function statusOf(flags, groups) {
  if (flags.todo) return "todo";
  if (flags.skip || groups.some((group) => group.flags.skip)) return "skip";
  if (groups.some((group) => group.flags.todo)) return "todo";
  return "run";
}

/**
 * Finds the tests declared in one file.
 * @returns {{ tests: { id: string, file: string, line: number, status: "run" | "skip" | "todo" }[],
 *             only: { id: string, file: string, line: number }[] }}
 */
export function extractTests(src, file) {
  const tokens = tokenize(src);
  const partner = matchBrackets(tokens);
  const tests = [];
  const only = [];
  const scopes = [];
  const seen = new Map();
  for (let k = 0; k < tokens.length; k += 1) {
    while (scopes.length > 0 && scopes[scopes.length - 1].close < k) scopes.pop();
    const token = tokens[k];
    if (token.type !== "ident" || !CALLEES.has(token.value)) continue;
    const previous = tokens[k - 1];
    const word = previous !== undefined && (previous.type === "punct" || previous.type === "ident");
    if (word && NOT_A_CALL_AFTER.has(previous.value)) continue;
    const declaration = parseDeclaration(src, tokens, k, partner);
    if (declaration === null) continue;
    // Calls inside a test body are run-time calls (Playwright's test.skip(), node:test subtests): ignored.
    if (scopes.some((scope) => scope.kind === "test")) continue;
    const name = [file, ...scopes.map((scope) => scope.title), declaration.title].join(" > ");
    if (declaration.flags.only) only.push({ id: name, file, line: declaration.line });
    if (declaration.kind === "test") {
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      tests.push({
        id: count === 1 ? name : `${name} #${count}`,
        file,
        line: declaration.line,
        status: statusOf(declaration.flags, scopes),
      });
    }
    scopes.push({
      kind: declaration.kind,
      close: declaration.close,
      title: declaration.title,
      flags: declaration.flags,
    });
  }
  return { tests, only };
}

/** @param {Iterable<[string, string | null]>} files pairs of [path, source] */
export function collectTests(files) {
  const tests = [];
  const only = [];
  for (const [file, source] of files) {
    if (source === null) continue;
    const found = extractTests(source, file);
    tests.push(...found.tests);
    only.push(...found.only);
  }
  return { tests, only };
}

// ---------------------------------------------------------------------------------------------------------
// tests/QUARANTINE.md

function splitRow(row) {
  let body = row.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

const normalizeName = (name) => name.replace(/\s+/g, " ").trim().replace(/^\.\//, "");

function namesInCell(cell) {
  const quoted = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  return (quoted.length > 0 ? quoted : [cell]).map(normalizeName).filter(Boolean);
}

/**
 * @returns {{ entries: { test: string, task: string, allowedBy: string, line: number, valid: boolean }[],
 *             problems: { line: number, problem: string }[] }}
 */
export function parseQuarantine(markdown) {
  const entries = [];
  const problems = [];
  let columns = null;
  markdown.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    const row = text.trim();
    if (!row.startsWith("|")) {
      columns = null;
      return;
    }
    const cells = splitRow(row);
    if (columns === null) {
      const lower = cells.map((cell) => cell.toLowerCase());
      const test = lower.findIndex((cell) => /\btests?\b/.test(cell));
      const task = lower.findIndex((cell) => /\btask\b/.test(cell));
      const allowed = lower.findIndex((cell) => cell.includes("allow"));
      if (test !== -1 && task !== -1 && allowed !== -1) columns = { test, task, allowed };
      return;
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) return;
    const names = namesInCell(cells[columns.test] ?? "");
    const task = /\b[TD]-\d+\b/.exec(cells[columns.task] ?? "")?.[0] ?? "";
    const allowedBy = (cells[columns.allowed] ?? "").trim();
    let problem = "";
    if (names.length === 0) problem = "the row names no test";
    else if (task === "") problem = "the row has no task id (T-xxx)";
    else if (!/\b(?:qa|architect|contract)/i.test(allowedBy)) {
      problem =
        'its "Allowed by" must name QA (quarantine, 7.8), the architect (ruling, 6.6) or a contract-removal task (6.4)';
    }
    if (problem !== "") problems.push({ line, problem });
    for (const test of names) entries.push({ test, task, allowedBy, line, valid: problem === "" });
  });
  return { entries, problems };
}

// ---------------------------------------------------------------------------------------------------------
// The comparison

function countsOf(set) {
  return {
    tests: set.tests.length,
    skipped: set.tests.filter((test) => test.status === "skip").length,
    todo: set.tests.filter((test) => test.status === "todo").length,
    only: set.only.length,
  };
}

/**
 * Compares two collections from collectTests.
 * @returns {{ counts: { base: object, branch: object }, errors: object[], notices: object[],
 *             allowed: object[], problems: object[] }}
 */
export function compareTests(
  base,
  branch,
  quarantine = { entries: [], problems: [] },
  baseName = DEFAULT_BASE,
) {
  const counts = { base: countsOf(base), branch: countsOf(branch) };
  const valid = quarantine.entries.filter((entry) => entry.valid);
  const findEntry = (id) => valid.find((entry) => id === entry.test || id.startsWith(`${entry.test} > `));
  const errors = [];
  const notices = [];
  const allowed = [];
  const baseById = new Map(base.tests.map((test) => [test.id, test]));
  const branchIds = new Set(branch.tests.map((test) => test.id));

  if (counts.branch.only > counts.base.only) {
    const before = new Set(base.only.map((marker) => marker.id));
    const added = branch.only.filter((marker) => !before.has(marker.id));
    for (const marker of added.length > 0 ? added : branch.only) {
      errors.push({
        kind: "only",
        id: marker.id,
        file: marker.file,
        line: marker.line,
        message: `.only on "${marker.id}": remove it (a new .only is never allowed)`,
      });
    }
  }

  for (const test of branch.tests) {
    if (test.status === "run") continue;
    const before = baseById.get(test.id);
    if (before !== undefined && before.status !== "run") continue;
    const word = test.status === "todo" ? "todo" : "skipped";
    const what = before === undefined ? `is a new ${word} test` : `is ${word} here but runs on ${baseName}`;
    const entry = findEntry(test.id);
    if (entry !== undefined) {
      allowed.push({ id: test.id, file: test.file, line: test.line, what, entry });
    } else {
      errors.push({
        kind: test.status,
        id: test.id,
        file: test.file,
        line: test.line,
        message: `"${test.id}" ${what}`,
      });
    }
  }

  const missing = base.tests.filter((test) => !branchIds.has(test.id));
  if (counts.branch.tests < counts.base.tests) {
    for (const test of missing) {
      const what = `is on ${baseName} but not on this branch, which has fewer tests`;
      const entry = findEntry(test.id);
      if (entry !== undefined) {
        allowed.push({ id: test.id, file: test.file, what, entry });
      } else {
        errors.push({ kind: "removed", id: test.id, file: test.file, message: `"${test.id}" ${what}` });
      }
    }
  } else {
    for (const test of missing) {
      notices.push({
        id: test.id,
        file: test.file,
        message: `"${test.id}" is no longer found by this name (renamed or moved?); the number of tests did not drop`,
      });
    }
  }
  return { counts, errors, notices, allowed, problems: quarantine.problems };
}

// ---------------------------------------------------------------------------------------------------------
// git

function git(cwd, args, { input, allowFailure = false, binary = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    // A string input would be encoded with `encoding`, which is not a text encoding for binary output.
    input: input === undefined ? undefined : Buffer.from(input, "utf8"),
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 1024 ** 3,
  });
  if (result.error) throw new GuardError(`could not run git: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr).trim() || `exit code ${result.status}`;
    throw new GuardError(`git ${args[0]} failed: ${detail}`);
  }
  return result;
}

function repositoryRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.status !== 0) throw new GuardError("this is not inside a git repository");
  return result.stdout.trim();
}

function resolveBase(root, ref) {
  const found = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  if (found.status !== 0) {
    throw new GuardError(
      `${ref} was not found. Run "git fetch origin main" first (CI checks out with fetch-depth: 0).`,
    );
  }
  const sha = found.stdout.trim();
  const mergeBase = git(root, ["merge-base", "HEAD", sha], { allowFailure: true });
  const common = mergeBase.status === 0 ? mergeBase.stdout.trim() : "";
  return { ref, sha, compare: common || sha, usedMergeBase: common !== "" };
}

function listTree(root, rev) {
  const out = git(root, ["ls-tree", "-r", "-z", "--full-tree", rev]).stdout;
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [, type, sha] = entry.slice(0, tab).split(" ");
      return { type, sha, path: entry.slice(tab + 1) };
    })
    .filter((entry) => entry.type === "blob");
}

// Tracked and untracked (not ignored) files that exist in the working tree and pass `keep`.
function listWorkingFiles(root, keep) {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).stdout;
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter(keep)
    .filter((file) => statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() ?? false);
}

function readBlobs(root, shas) {
  if (shas.length === 0) return [];
  const out = git(root, ["cat-file", "--batch"], { input: `${shas.join("\n")}\n`, binary: true }).stdout;
  const sources = [];
  let position = 0;
  for (const sha of shas) {
    const newline = out.indexOf(10, position);
    if (newline === -1) throw new GuardError(`git cat-file returned nothing for blob ${sha}`);
    const header = out.subarray(position, newline).toString("utf8").split(" ");
    position = newline + 1;
    if (header.length < 3 || header[1] === "missing") {
      sources.push(null);
      continue;
    }
    const size = Number(header[2]);
    sources.push(out.subarray(position, position + size).toString("utf8"));
    position += size + 1;
  }
  return sources;
}

// ---------------------------------------------------------------------------------------------------------
// Output: plain lines, or GitHub annotations when running in GitHub Actions.

const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

function createReporter(env, write) {
  const github = env.GITHUB_ACTIONS === "true";
  const emit = (level, label, message, where = {}) => {
    if (github) {
      const props = [];
      if (where.file) props.push(`file=${escapeProperty(where.file)}`);
      if (where.file && where.line) props.push(`line=${where.line}`);
      props.push(`title=${escapeProperty(TITLE)}`);
      write(`::${level} ${props.join(",")}::${escapeData(message)}`);
    } else {
      const location = where.file ? `${where.file}${where.line ? `:${where.line}` : ""}  ` : "";
      write(`${label} ${location}${message}`);
    }
  };
  return {
    error: (message, where) => emit("error", "FAIL", message, where),
    notice: (message, where) => emit("notice", "NOTE", message, where),
    info: (message) => write(message),
  };
}

function listCapped(items, show) {
  items.slice(0, MAX_LISTED).forEach(show);
  return items.length > MAX_LISTED ? items.length - MAX_LISTED : 0;
}

/** Runs the guard; returns the exit code. */
export function main(
  argv,
  { cwd = process.cwd(), env = process.env, write = (line) => console.log(line) } = {},
) {
  const report = createReporter(env, write);
  let baseRef = DEFAULT_BASE;
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === "--help" || arg === "-h") {
      write(USAGE);
      return 0;
    }
    if (arg === "--base" && argv[k + 1] !== undefined) {
      baseRef = argv[k + 1];
      k += 1;
    } else if (arg.startsWith("--base=")) {
      baseRef = arg.slice("--base=".length);
    } else {
      report.error(`unknown argument "${arg}". ${USAGE}`);
      return 2;
    }
  }
  try {
    if (baseRef === "" || baseRef.startsWith("-")) throw new GuardError(`"${baseRef}" is not a git ref`);
    const root = repositoryRoot(cwd);
    const base = resolveBase(root, baseRef);
    const baseFiles = listTree(root, base.compare).filter((entry) => isTestFile(entry.path));
    const baseSources = readBlobs(
      root,
      baseFiles.map((entry) => entry.sha),
    );
    const baseTests = collectTests(baseFiles.map((entry, k) => [entry.path, baseSources[k] ?? null]));
    const branchFiles = listWorkingFiles(root, isTestFile);
    const branchTests = collectTests(
      branchFiles.map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
    );
    const quarantineText = statSync(path.join(root, QUARANTINE_FILE), { throwIfNoEntry: false })?.isFile()
      ? readFileSync(path.join(root, QUARANTINE_FILE), "utf8")
      : "";
    const result = compareTests(baseTests, branchTests, parseQuarantine(quarantineText), baseRef);

    const against = base.usedMergeBase
      ? `the merge-base of HEAD and ${baseRef} (${base.compare.slice(0, 10)})`
      : `${baseRef} (${base.compare.slice(0, 10)}; no merge-base found)`;
    report.info(`test guard: this branch against ${against}`);
    for (const key of ["tests", "skipped", "todo", "only"]) {
      report.info(
        `  ${key.padEnd(8)} ${String(result.counts.base[key]).padStart(5)} -> ${result.counts.branch[key]}`,
      );
    }
    for (const problem of result.problems) {
      report.notice(`row ignored: ${problem.problem}`, { file: QUARANTINE_FILE, line: problem.line });
    }
    let more = listCapped(result.allowed, (item) =>
      report.notice(
        `"${item.id}" ${item.what}: allowed by ${QUARANTINE_FILE} line ${item.entry.line} (${item.entry.task}, ${item.entry.allowedBy})`,
        { file: item.file, line: item.line },
      ),
    );
    if (more > 0) report.info(`  ... and ${more} more allowed by ${QUARANTINE_FILE}`);
    more = listCapped(result.notices, (item) => report.notice(item.message, { file: item.file }));
    if (more > 0) report.info(`  ... and ${more} more renamed or moved`);
    for (const error of result.errors) report.error(error.message, { file: error.file, line: error.line });

    if (result.errors.length === 0) {
      report.info("test guard: passed");
      return 0;
    }
    const allowable = result.errors.filter((error) => error.kind !== "only");
    if (allowable.length > 0) {
      report.info("");
      report.info(
        `A removed or skipped test passes only when QA lists it in ${QUARANTINE_FILE} (build prompt 5.2):`,
      );
      report.info("| Test | Task | Allowed by | Reason |");
      report.info("|---|---|---|---|");
      for (const error of allowable.slice(0, MAX_LISTED)) {
        report.info(`| \`${error.id}\` | T-xxx | QA quarantine (7.8) | <why> |`);
      }
    }
    report.info(
      `test guard: FAILED (${result.errors.length} problem${result.errors.length === 1 ? "" : "s"})`,
    );
    return 1;
  } catch (error) {
    if (error instanceof GuardError) {
      report.error(`test guard could not run: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

function runAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) process.exitCode = main(process.argv.slice(2));
