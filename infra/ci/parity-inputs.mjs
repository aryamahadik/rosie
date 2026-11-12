#!/usr/bin/env node
// The parity inputs' package.json rule (T-1320; DL-589, DL-600). ES module, so strict mode is on. No dependency:
// the parity-inputs job runs it before any `npm ci`, with the runner's own Node.
//
//   node infra/ci/parity-inputs.mjs <base> <head>
//
// .github/workflows/merge-check.yml's parity-inputs step lists the parity inputs (compiler/src, fixtures/master,
// vitest.config.ts, package.json, package-lock.json). When package.json is the only one that changed on the branch
// rebased onto origin/main, the step runs this rule, as origin/main holds it (never the branch's copy), with
// origin/main and HEAD. The local merge-check runs that step as written, so it applies the same rule.
//
// A package.json change is a parity input unless it is confined to the scripts object and leaves every script the
// parity run runs unchanged. The parity run's scripts:
//   - test:parity (the shard job runs `npm run test:parity -- --shard=i/N`), and the root package's scripts that
//     the job's `npm ci` runs before it: preinstall, install, postinstall, prepublish, preprepare, prepare,
//     postprepare and dependencies;
//   - for each script run by its name, its pre and post scripts (npm runs pre<name> and post<name> around it);
//   - every script that a line of theirs names, on origin/main or on the branch, followed to the end. A name counts
//     wherever it stands as a whole word ("npm run x", "npm run-script x", "node --run x", "npm:x", "--script=x"),
//     quotes and backslashes dropped first as the shell drops them; and npm's own commands count for the scripts
//     they run without naming them ("npm t" runs test; "npm restart" stop and start; "npm pack" prepare).
// Every other field still counts (dependencies of every kind, overrides, resolutions, engines, packageManager,
// workspaces, type, imports, exports, config, and any other): the manifest without its scripts must be the same
// parsed JSON, key order included, so a reordered field counts too. A change of layout alone (the same JSON) is
// no input.
//
// It fails closed. Each of these makes the change an input: either side not a JSON object; a scripts value that is
// not an object of strings; a script name outside A-Z a-z 0-9 : . _ @ + / - (a word could not hold it); and a
// parity script whose line names scripts this rule cannot read ($ or a backtick: a variable or a command; * ? [ ]
// { } or %: a pattern). It does not follow a script reached only through another file (a shell script, a test, the
// Vitest config): today test:parity runs `vitest run --project parity` and npm ci runs no root script.
//
// Output: one line on standard output, "scripts-only" (package.json is not a parity input) or "input", and the
// reasons on standard error. Exit 0 with a verdict, 2 when it cannot judge (a usage error, a ref that is not a
// commit, a failed git command): the step then fails, and so does the run, so a broken rule never skips the shards.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MANIFEST = "package.json";
export const SCRIPTS_ONLY = "scripts-only";
export const INPUT = "input";
const USAGE = "Usage: node infra/ci/parity-inputs.mjs <base> <head>   (the step: origin/main HEAD)";

/** The scripts the parity shard job runs by their names: test:parity, after npm ci's root install scripts. */
export const PARITY_RUN = [
  "test:parity",
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
];

// npm's commands that run scripts their line does not name (npm's docs: "scripts" and each command's page). A
// command that names its script (npm test, start, stop, version, shrinkwrap, run x) is read as a word anyway.
const NPM_RUNS = new Map([
  ["t", ["test"]],
  ["tst", ["test"]],
  ["it", ["test"]],
  ["cit", ["test"]],
  ["install-test", ["test"]],
  ["install-ci-test", ["test"]],
  ["restart", ["stop", "start"]],
  ["pack", ["prepack", "prepare", "postpack"]],
  ["publish", ["prepublishOnly", "prepack", "prepare", "postpack"]],
]);

const NAME = /^[A-Za-z0-9:._@+/-]+$/;
const BETWEEN_WORDS = /[^A-Za-z0-9:._@+/-]+/;
const UNREADABLE = /[$`*?[\]{}%]/;

class RuleError extends Error {}

/** The words of one script line, quotes and backslashes dropped first (the shell joins what they split). */
export function wordsOf(line) {
  const words = [];
  for (const word of line.replace(/["'\\]/g, "").split(BETWEEN_WORDS)) {
    if (word === "") continue;
    words.push(word);
    // concurrently's and npm-run-all's "npm:<script>".
    if (word.startsWith("npm:") && word.length > 4) words.push(word.slice(4));
  }
  return words;
}

/**
 * The scripts the parity run runs, read from both sides' scripts (Maps of name to line): { names, unreadable }.
 * unreadable is the first of them whose line names scripts this rule cannot read, else null.
 */
export function parityScripts(base, head) {
  const names = new Set();
  const order = [];
  const add = (name) => {
    if (names.has(name)) return;
    names.add(name);
    order.push(name);
  };
  // A script npm runs by its name brings its pre and post scripts (but not theirs).
  const run = (name) => {
    add(name);
    add(`pre${name}`);
    add(`post${name}`);
  };
  PARITY_RUN.forEach(run);
  // An array's iterator reads its length at each step, so the names added on the way are visited too.
  for (const name of order) {
    for (const line of [base.get(name), head.get(name)]) {
      if (line === undefined) continue;
      if (UNREADABLE.test(line)) return { names, unreadable: name };
      for (const word of wordsOf(line)) {
        run(word);
        for (const implied of NPM_RUNS.get(word) ?? []) run(implied);
      }
    }
  }
  return { names, unreadable: null };
}

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// One side's package.json: { fields: Map of each field but scripts to its JSON, scripts: Map } or { error }.
function readManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return { error: `is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isMap(manifest)) return { error: "is not a JSON object" };
  const fields = new Map();
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== "scripts") fields.set(key, JSON.stringify(value));
  }
  const scripts = Object.hasOwn(manifest, "scripts") ? manifest.scripts : {};
  if (!isMap(scripts) || !Object.values(scripts).every((line) => typeof line === "string")) {
    return { error: "has a scripts value that is not an object of strings" };
  }
  return { fields, scripts: new Map(Object.entries(scripts)) };
}

// The fields besides scripts whose value differs; "(their order)" when only their order does.
function changedFields(base, head) {
  const keys = [...new Set([...base.keys(), ...head.keys()])];
  const changed = keys.filter((key) => base.get(key) !== head.get(key));
  if (changed.length === 0 && JSON.stringify([...base.keys()]) !== JSON.stringify([...head.keys()])) {
    changed.push("(their order)");
  }
  return changed;
}

/**
 * The verdict on package.json's change from baseText (the merge-base's) to headText (the branch's), each null when
 * that side has no package.json: { input, reasons }. input is false only when the change is confined to the
 * scripts object and leaves every script the parity run runs unchanged.
 */
export function manifestVerdict(baseText, headText) {
  const input = (reason) => ({ input: true, reasons: [reason] });
  if (baseText === null) return input("package.json is new on the branch");
  if (headText === null) return input("the branch removes package.json");
  const base = readManifest(baseText);
  if (base.error !== undefined) return input(`package.json on origin/main ${base.error}`);
  const head = readManifest(headText);
  if (head.error !== undefined) return input(`the branch's package.json ${head.error}`);
  const fields = changedFields(base.fields, head.fields);
  if (fields.length > 0) return input(`fields besides scripts changed: ${fields.join(", ")}`);
  const all = [...new Set([...base.scripts.keys(), ...head.scripts.keys()])];
  const odd = all.find((name) => !NAME.test(name));
  if (odd !== undefined) return input(`the script name ${JSON.stringify(odd)} is not one this rule can read`);
  const changed = all.filter((name) => base.scripts.get(name) !== head.scripts.get(name));
  if (changed.length === 0) return { input: false, reasons: ["no field changed (the same JSON)"] };
  const parity = parityScripts(base.scripts, head.scripts);
  if (parity.unreadable !== null) {
    return input(`the parity run's script ${parity.unreadable} names scripts this rule cannot read`);
  }
  const ran = changed.filter((name) => parity.names.has(name));
  if (ran.length > 0) return input(`scripts the parity run runs changed: ${ran.join(", ")}`);
  return { input: false, reasons: [`only scripts the parity run never runs changed: ${changed.join(", ")}`] };
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const why = result.error?.message ?? result.stderr.trim().split("\n").at(-1) ?? "";
    throw new RuleError(`git ${args[0]} failed: ${why || `exit ${result.status ?? result.signal}`}`);
  }
  return result.stdout;
}

function commitOf(ref) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new RuleError(`${ref} is not a commit here`);
  return result.stdout.trim();
}

// package.json's text at a commit, or null when the commit has none.
function manifestAt(commit) {
  if (git(["ls-tree", "--name-only", commit, "--", MANIFEST]).trim() === "") return null;
  return git(["show", `${commit}:${MANIFEST}`]);
}

/** Judges package.json's change from the merge-base of argv's <base> and <head> to <head>; returns the exit code. */
export function main(argv) {
  if (argv.length !== 2 || argv.some((arg) => arg === "" || arg.startsWith("-"))) {
    process.stderr.write(`parity-inputs: name the two refs\n${USAGE}\n`);
    return 2;
  }
  let verdict;
  try {
    const [base, head] = argv.map(commitOf);
    const mergeBase = git(["merge-base", base, head]).trim();
    verdict = manifestVerdict(manifestAt(mergeBase), manifestAt(head));
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    process.stderr.write(`parity-inputs: ${error.message}\n`);
    return 2;
  }
  for (const reason of verdict.reasons) process.stderr.write(`parity-inputs: ${reason}\n`);
  process.stdout.write(`${verdict.input ? INPUT : SCRIPTS_ONLY}\n`);
  return 0;
}

const invoked = process.argv[1] === undefined ? "" : realpathSync(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
