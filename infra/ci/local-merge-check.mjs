#!/usr/bin/env node
// The merge-check, run on the build Mac (T-1111, DL-190): what .github/workflows/merge-check.yml runs, with no
// GitHub Actions. ES module, so strict mode is on.
//
//   npm run merge-check:local -- task/T-xxx [--ai-change] [--verbose]
//
// The steps come from merge-check.yml itself, read at origin/main (the file `gh workflow run merge-check.yml`
// runs) with a small reader for that file's shape, so the two cannot drift: a new or changed run step runs as
// written, and anything this runner cannot mirror (an unknown action, key or expression) fails the run before
// any step starts. In file order:
//   - merge-check's job. Its postgres service is a throwaway database of the run's own in the local rosie-pg
//     container (factory spec 4: 127.0.0.1:54329, rosie/rosie, local only, not a secret), made from
//     template_postgis as the service image makes its database, and dropped after the run, pass or fail.
//     actions/checkout is a fresh `git clone` of this repository's git store by path (no network, no token),
//     with origin/main and the branch set to what this repository holds. actions/setup-node checks that
//     `node --version` matches .nvmrc. Each run step runs as Actions runs it (bash --noprofile --norc -eo
//     pipefail, CI=true, the job's and the step's env, ${{ }} filled in). The first failing step stops the run;
//     an `if: always()` step still runs.
//   - parity-inputs' rule, in the same clone, then, only when a parity input changed, the parity shards one
//     after another. The leading steps a job shares with an earlier job (branch check, checkout, rebase, Node,
//     npm ci) are done once, in the shared clone; the matrix keeps its fail-fast.
// origin/main is this repository's remote-tracking ref: `git fetch origin` before a run.
//
// Output: scratch/ci/<branch, "/" as "-">-<short branch head>/ holds merge-check.log (every step's full output),
// result.json (branch, branch head, origin/main, the rebased commit checked, each step's name, command, status
// and seconds, ai_change, the result) and summary.md (the job summary). Exit 0 only when every step passed; 1 when
// one failed; 2 on a usage error; 130 when interrupted. It never pushes (the clone's push URL is a dead end) and
// reads no secret: steps get this shell's environment without git, GitHub, Cloudflare, npm, database or key
// variables.
//
// For tests: --repo <path> checks a branch of another repository, --out-dir <path> moves the result folder, and
// MERGE_CHECK_PG_URL names another local PostgreSQL server (its maintenance database).

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_FILE = ".github/workflows/merge-check.yml";
const MAIN_REF = "refs/remotes/origin/main";
// The local rosie-pg's maintenance database (factory spec 4; local only, not a secret).
const DEFAULT_PG_URL = "postgres://rosie:rosie@127.0.0.1:54329/postgres";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RUN_DATABASE = /^mc_\d{8}t\d{6}_[0-9a-f]{6}$/;
// GitHub's timeout-minutes for a job that names none.
const DEFAULT_JOB_MINUTES = 360;
const TAIL_LINES = 60;
const SERVICE_START = "Start the postgres service (a throwaway database in the local rosie-pg)";
const SERVICE_STOP = "Stop the postgres service (drop the throwaway database)";
const USAGE = "Usage: npm run merge-check:local -- task/T-xxx [--ai-change] [--verbose]";

class UsageError extends Error {}
/** merge-check.yml holds something this runner cannot mirror; the run stops before any step starts. */
export class DriftError extends Error {}
class StepError extends Error {}

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------------------------------------
// A YAML reader for merge-check.yml's shape: block mappings and lists, "- key: value" list items, literal (|)
// and folded (>) block text, quoted and plain values, one-line [a, b] lists, and comments. Anything else
// (anchors, tags, {maps}, quoted text over several lines, tabs) is refused with its line number, never guessed.

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: +(.*))?$/;
const BLOCK_HEADER = /^([|>])([+-]?)\s*(?:#.*)?$/;
const ESCAPED = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
]);

function fold(lines) {
  let text = lines[0];
  for (let k = 1; k < lines.length; k += 1) {
    const line = lines[k];
    const previous = lines[k - 1];
    if (line === "") text += "\n";
    else if (previous === "") text += line;
    else if (/^\s/.test(line) || /^\s/.test(previous)) text += `\n${line}`;
    else text += ` ${line}`;
  }
  return text;
}

/** Reads YAML text of merge-check.yml's shape into plain objects, lists, strings, numbers and booleans. */
export function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const fail = (message, at = i) => {
    throw new DriftError(`line ${at + 1}: ${message}`);
  };
  const indentOf = (line) => {
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.includes("\t")) fail("a tab in the indentation");
    return lead.length;
  };
  const blank = (line) => line.trim() === "" || line.trim().startsWith("#");
  const nextContent = () => {
    while (i < lines.length && blank(lines[i])) i += 1;
    return i < lines.length;
  };
  const isItem = (body) => body === "-" || body.startsWith("- ");
  const node = (indent) => (isItem(lines[i].slice(indent)) ? list(indent) : mapping(indent));

  function mapping(indent) {
    const map = {};
    while (nextContent()) {
      const at = indentOf(lines[i]);
      const body = lines[i].slice(at);
      if (at < indent || (at === indent && isItem(body))) break;
      if (at > indent) fail("unexpected indentation");
      const match = KEY_LINE.exec(body);
      if (!match) fail(`not a "key: value" line: ${body}`);
      const [, key, rest = ""] = match;
      if (Object.hasOwn(map, key)) fail(`the key ${key} twice`);
      const keyLine = i;
      i += 1;
      map[key] = value(rest, indent, keyLine);
    }
    return map;
  }

  function value(raw, indent, at) {
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) {
      if (!nextContent()) return null;
      const next = indentOf(lines[i]);
      if (next > indent) return node(next);
      if (next === indent && isItem(lines[i].slice(next))) return list(next);
      return null;
    }
    const header = BLOCK_HEADER.exec(text);
    if (header) return block(header[1], header[2], indent);
    return scalar(text, at);
  }

  function list(indent) {
    const items = [];
    while (nextContent()) {
      const at = indentOf(lines[i]);
      const body = lines[i].slice(at);
      if (at < indent || (at === indent && !isItem(body))) break;
      if (at > indent) fail("unexpected indentation");
      const rest = body.slice(1).trimStart();
      const itemLine = i;
      if (rest === "" || rest.startsWith("#")) {
        i += 1;
        const nested = nextContent() ? indentOf(lines[i]) : -1;
        items.push(nested > indent ? node(nested) : null);
      } else if (KEY_LINE.test(rest)) {
        // "- key: value": a mapping whose keys line up with this first key.
        const keyIndent = at + body.length - rest.length;
        lines[i] = " ".repeat(keyIndent) + rest;
        items.push(mapping(keyIndent));
      } else {
        i += 1;
        const header = BLOCK_HEADER.exec(rest);
        items.push(header ? block(header[1], header[2], indent) : scalar(rest, itemLine));
      }
    }
    return items;
  }

  // Block text: the lines indented past `parent`; the first one sets the indentation removed from all.
  function block(style, chomp, parent) {
    const raw = [];
    let indent = -1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        raw.push("");
        i += 1;
        continue;
      }
      const at = indentOf(line);
      if (at <= parent) break;
      if (indent === -1) indent = at;
      if (at < indent) fail("a block text line left of its first line");
      raw.push(line.slice(indent));
      i += 1;
    }
    let end = raw.length;
    while (end > 0 && raw[end - 1] === "") end -= 1;
    const content = raw.slice(0, end);
    if (content.length === 0) return "";
    const body = style === "|" ? content.join("\n") : fold(content);
    if (chomp === "-") return body;
    return chomp === "+" ? `${body}\n${"\n".repeat(raw.length - end)}` : `${body}\n`;
  }

  function unescape(code, at) {
    if (code.length === 5) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    if (!ESCAPED.has(code)) fail(`the escape \\${code}`, at);
    return ESCAPED.get(code);
  }

  function flowItems(inner, at) {
    const items = [];
    let current = "";
    let quote = "";
    for (const ch of inner) {
      if (quote !== "") {
        current += ch;
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === ",") {
        items.push(current.trim());
        current = "";
      } else if ("[]{}".includes(ch)) {
        fail("a list or map inside a [list]", at);
      } else {
        current += ch;
      }
    }
    if (quote !== "") fail("an unclosed quote in a [list]", at);
    if (current.trim() !== "" || items.length > 0) items.push(current.trim());
    if (items.length > 0 && items.at(-1) === "") items.pop();
    if (items.includes("")) fail("an empty item in a [list]", at);
    return items;
  }

  function scalar(text, at) {
    if (text.startsWith('"')) {
      const match = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(text);
      if (!match) fail("a double-quoted value that does not end on its line", at);
      return match[1].replace(/\\(u[0-9A-Fa-f]{4}|.)/g, (_, code) => unescape(code, at));
    }
    if (text.startsWith("'")) {
      const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
      if (!match) fail("a single-quoted value that does not end on its line", at);
      return match[1].replaceAll("''", "'");
    }
    if (text.startsWith("[")) {
      const match = /^\[(.*)\]\s*(?:#.*)?$/.exec(text);
      if (!match) fail("a [list] that does not end on its line", at);
      return flowItems(match[1], at).map((item) => scalar(item, at));
    }
    if (/^[{&*!%@`|>]/.test(text)) fail(`a value this reader does not read: ${text}`, at);
    const plain = text.replace(/\s+#.*$/, "");
    if (plain === "true" || plain === "false") return plain === "true";
    if (plain === "null" || plain === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(plain)) return Number(plain);
    return plain;
  }

  if (nextContent() && lines[i].trim() === "---") i += 1;
  if (!nextContent()) return null;
  if (indentOf(lines[i]) !== 0) fail("the first line is indented");
  const document = node(0);
  if (nextContent()) fail("text after the document's end");
  return document;
}

// ---------------------------------------------------------------------------------------------------------
// Expressions: the ${{ }} subset merge-check.yml uses. Contexts inputs, matrix, job, needs and steps; the status
// calls; 'text', numbers, true, false and null; ==, !=, !, && and || with Actions' loose equality.

const CONTEXTS = ["inputs", "matrix", "job", "needs", "steps"];
const INPUTS = ["branch", "ai_change"];
const STATUS_CALLS = ["always", "success", "failure", "cancelled"];
const TOKEN =
  /\s+|(==|!=|&&|\|\||[!()])|'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)/y;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

function lex(source, where) {
  const tokens = [];
  let k = 0;
  while (k < source.length) {
    TOKEN.lastIndex = k;
    const match = TOKEN.exec(source);
    if (!match) {
      const why = `cannot be read from "${source.slice(k)}"`;
      throw new DriftError(`${where}: the expression "${source.trim()}" ${why}`);
    }
    k = TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ op: match[1] });
    else if (match[2] !== undefined) tokens.push({ value: match[2].replaceAll("''", "'") });
    else if (match[3] !== undefined) tokens.push({ value: Number(match[3]) });
    else if (match[4] !== undefined) tokens.push({ word: match[4] });
  }
  return tokens;
}

/** Parses one expression (the text inside ${{ }}); throws DriftError for anything outside the subset. */
export function parseExpression(source, where = "expression") {
  const tokens = lex(source, where);
  let k = 0;
  const fail = (why) => {
    throw new DriftError(`${where}: the expression "${source.trim()}": ${why}`);
  };
  const isOp = (op) => tokens[k]?.op === op;
  const binary = (next, ops) => () => {
    let left = next();
    while (ops.some(isOp)) {
      const op = tokens[k].op;
      k += 1;
      left = { op, left, right: next() };
    }
    return left;
  };
  const call = (word) => {
    if (!STATUS_CALLS.includes(word) || tokens[k + 1]?.op !== ")") fail(`the call ${word}()`);
    k += 2;
    return { call: word };
  };
  const context = (word) => {
    const parts = word.split(".");
    if (!CONTEXTS.includes(parts[0])) {
      fail(`the context ${parts[0]}; this runner fills ${CONTEXTS.join(", ")}`);
    }
    if (parts[0] === "inputs" && !INPUTS.includes(parts[1])) fail(`${word} is not an input`);
    return { path: parts };
  };
  const primary = () => {
    const token = tokens[k];
    k += 1;
    if (token === undefined) fail("it ends early");
    if (token.op === "!") return { op: "!", left: primary() };
    if (token.op === "(") {
      const inner = or();
      if (!isOp(")")) fail("a ( without its )");
      k += 1;
      return inner;
    }
    if ("value" in token) return { value: token.value };
    if (token.word === undefined) fail(`an unexpected ${token.op}`);
    if (token.word === "true" || token.word === "false") return { value: token.word === "true" };
    if (token.word === "null") return { value: null };
    return isOp("(") ? call(token.word) : context(token.word);
  };
  const equality = binary(primary, ["==", "!="]);
  const and = binary(equality, ["&&"]);
  const or = binary(and, ["||"]);
  const tree = or();
  if (k !== tokens.length) fail("text after its end");
  return tree;
}

function truthy(value) {
  if (value === null || value === undefined || value === false || value === "") return false;
  return !(typeof value === "number" && (value === 0 || Number.isNaN(value)));
}

function looseEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  const number = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
    return Number(v);
  };
  return number(a) === number(b);
}

/** The value of a parsed expression in a context { inputs, matrix, job, needs, steps, ok, cancelled }. */
export function evaluate(tree, context) {
  if ("value" in tree) return tree.value;
  if ("call" in tree) {
    if (tree.call === "always") return true;
    if (tree.call === "cancelled") return context.cancelled === true;
    return tree.call === "success" ? context.ok : !context.ok;
  }
  if ("path" in tree) {
    let value = context;
    for (const part of tree.path) {
      value = isMap(value) && Object.hasOwn(value, part) ? value[part] : null;
    }
    return value;
  }
  if (tree.op === "!") return !truthy(evaluate(tree.left, context));
  const left = evaluate(tree.left, context);
  if (tree.op === "&&") return truthy(left) ? evaluate(tree.right, context) : left;
  if (tree.op === "||") return truthy(left) ? left : evaluate(tree.right, context);
  const equal = looseEqual(left, evaluate(tree.right, context));
  return tree.op === "==" ? equal : !equal;
}

// An if: value is an expression, with or without ${{ }}.
function parseCondition(condition, where) {
  const text = String(condition).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  return parseExpression(wrapped ? wrapped[1] : text, where);
}

function hasStatusCall(tree) {
  if ("call" in tree) return true;
  return [tree.left, tree.right].some((side) => side !== undefined && hasStatusCall(side));
}

/** Actions' rule: an if: with no status call means success() && (if:); no if: means success(). */
export function conditionHolds(condition, context) {
  if (condition === null) return context.ok;
  const tree = parseCondition(condition, "if");
  const holds = truthy(evaluate(tree, context));
  return hasStatusCall(tree) ? holds : context.ok && holds;
}

function checkExpressions(text, where) {
  for (const match of String(text).matchAll(EXPRESSION)) parseExpression(match[1], where);
}

/** The text with each ${{ }} replaced by its value (null as ""), as Actions does before a step runs. */
export function fill(text, context) {
  return String(text).replace(EXPRESSION, (_, source) => {
    const value = evaluate(parseExpression(source), context);
    return value === null || value === undefined ? "" : String(value);
  });
}

function fillAll(map, context) {
  const out = {};
  for (const [key, value] of Object.entries(map)) out[key] = fill(value, context);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The workflow model: what each job and step holds, checked against what this runner can mirror.

const TOP_KEYS = ["name", "on", "permissions", "concurrency", "defaults", "env", "jobs"];
const JOB_KEYS = [
  "name",
  "runs-on",
  "timeout-minutes",
  "services",
  "env",
  "steps",
  "needs",
  "if",
  "outputs",
  "strategy",
];
const STEP_KEYS = ["name", "id", "if", "run", "uses", "with", "env"];

function keysOf(map, allowed, where) {
  if (!isMap(map)) throw new DriftError(`${where} is not a mapping`);
  for (const key of Object.keys(map)) {
    if (!allowed.includes(key)) {
      throw new DriftError(`${where}: the key ${key}, which this runner does not mirror`);
    }
  }
  return map;
}

// A mapping of names to one value each (env:, outputs:, with:), as text.
function texts(map, where) {
  if (!isMap(map)) throw new DriftError(`${where} is not a mapping`);
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (isMap(value) || Array.isArray(value)) throw new DriftError(`${where}: ${key} is not one value`);
    out[key] = value === null ? "" : String(value);
  }
  return out;
}

function readService(where, service) {
  keysOf(service, ["image", "env", "ports", "options"], `${where}: services.postgres`);
  const image = String(service.image ?? "");
  const match = /^postgis\/postgis:(\d+)-(\d+\.\d+)(?:-[a-z0-9.]+)?$/.exec(image);
  if (!match) {
    throw new DriftError(`${where}: the service image ${image} is not a postgis/postgis:<pg>-<postgis> tag`);
  }
  return { image, postgres: match[1], postgis: match[2] };
}

function readAction(at, name, uses, options) {
  const action = /^actions\/(checkout|setup-node)@v\d+$/.exec(uses);
  if (!action) throw new DriftError(`${at} (${name}): uses ${uses}, which this runner does not mirror`);
  if (action[1] === "checkout") {
    keysOf(options, ["ref", "fetch-depth", "persist-credentials"], `${at}: with`);
    if (options.ref !== "${{ inputs.branch }}") {
      throw new DriftError(`${at}: checks out ${options.ref}; this runner checks out the branch input`);
    }
    if (options["fetch-depth"] !== 0) {
      throw new DriftError(`${at}: fetch-depth ${options["fetch-depth"]}; this runner clones all history`);
    }
  } else {
    keysOf(options, ["node-version-file", "cache"], `${at}: with`);
    if (typeof options["node-version-file"] !== "string") {
      throw new DriftError(`${at}: setup-node without node-version-file`);
    }
  }
  return action[1];
}

function readStep(where, step, index) {
  const at = `${where}, step ${index + 1}`;
  keysOf(step, STEP_KEYS, at);
  const hasRun = typeof step.run === "string";
  const hasUses = typeof step.uses === "string";
  if (hasRun === hasUses) throw new DriftError(`${at}: a step has either run or uses`);
  const name = String(step.name ?? (hasRun ? `Run ${step.run.split("\n")[0]}` : `Run ${step.uses}`));
  const options = step.with ?? {};
  if (hasRun && step.with !== undefined) throw new DriftError(`${at}: with on a run step`);
  const kind = hasUses ? readAction(at, name, step.uses, options) : "run";
  const env = texts(step.env ?? {}, `${at}: env`);
  if (hasRun) checkExpressions(step.run, `${at}: run`);
  for (const [key, text] of Object.entries(env)) checkExpressions(text, `${at}: env ${key}`);
  const condition = step.if === undefined ? null : String(step.if);
  const always = condition !== null && hasStatusCall(parseCondition(condition, `${at}: if`));
  return {
    name,
    id: step.id === undefined ? null : String(step.id),
    if: condition,
    always,
    kind,
    run: hasRun ? step.run : null,
    uses: hasUses ? step.uses : null,
    with: texts(options, `${at}: with`),
    env,
  };
}

function readMatrix(where, strategy) {
  keysOf(strategy, ["matrix", "fail-fast"], `${where}: strategy`);
  const axes = isMap(strategy.matrix) ? Object.entries(strategy.matrix) : [];
  if (axes.length !== 1 || !Array.isArray(axes[0][1]) || axes[0][1].length === 0) {
    throw new DriftError(`${where}: this runner reads a matrix of one non-empty list`);
  }
  return { key: axes[0][0], values: axes[0][1], failFast: strategy["fail-fast"] !== false };
}

function readJob(id, job) {
  const where = `job ${id}`;
  keysOf(job, JOB_KEYS, where);
  const needs = job.needs === undefined ? [] : [job.needs].flat().map(String);
  const services = keysOf(job.services ?? {}, ["postgres"], `${where}: services`);
  const service = services.postgres === undefined ? null : readService(where, services.postgres);
  const matrix = job.strategy === undefined ? null : readMatrix(where, job.strategy);
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    throw new DriftError(`${where} has no steps`);
  }
  const steps = job.steps.map((step, index) => readStep(where, step, index));
  const env = texts(job.env ?? {}, `${where}: env`);
  for (const [key, text] of Object.entries(env)) {
    checkExpressions(text, `${where}: env ${key}`);
    if (service === null && /^postgres(ql)?:\/\//.test(text)) {
      throw new DriftError(`${where}: env ${key} names a database, but the job has no postgres service`);
    }
  }
  const outputs = texts(job.outputs ?? {}, `${where}: outputs`);
  for (const text of Object.values(outputs)) checkExpressions(text, `${where}: outputs`);
  if (job.if !== undefined) parseCondition(job.if, `${where}: if`);
  const minutes = job["timeout-minutes"] ?? DEFAULT_JOB_MINUTES;
  if (typeof minutes !== "number" || minutes <= 0) {
    throw new DriftError(`${where}: timeout-minutes ${minutes}`);
  }
  return {
    id,
    name: String(job.name ?? id),
    needs,
    if: job.if === undefined ? null : String(job.if),
    minutes,
    env,
    service,
    matrix,
    outputs,
    steps,
  };
}

/**
 * Reads merge-check.yml's text into { name, env, jobs }: each job's needs, if, timeout, env, postgres service,
 * matrix, outputs and steps ({ name, id, if, always, kind: "run" | "checkout" | "setup-node", run, uses, with,
 * env }), in file order. Throws DriftError for anything this runner cannot mirror.
 */
export function readWorkflow(text) {
  const doc = keysOf(parseYaml(text), TOP_KEYS, "merge-check.yml");
  const defaults = keysOf(doc.defaults ?? {}, ["run"], "defaults");
  const shell = keysOf(defaults.run ?? {}, ["shell"], "defaults.run").shell ?? "bash";
  if (shell !== "bash") {
    throw new DriftError(`defaults.run.shell is ${shell}; this runner runs bash steps`);
  }
  const inputs = doc.on?.workflow_dispatch?.inputs;
  if (!isMap(inputs) || !isMap(inputs.branch)) {
    throw new DriftError("on.workflow_dispatch.inputs.branch is missing");
  }
  keysOf(inputs, INPUTS, "on.workflow_dispatch.inputs");
  if (!isMap(doc.jobs) || Object.keys(doc.jobs).length === 0) {
    throw new DriftError("merge-check.yml has no jobs");
  }
  const jobs = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    const read = readJob(id, job);
    for (const need of read.needs) {
      if (!jobs.some((earlier) => earlier.id === need)) {
        throw new DriftError(`job ${id} needs ${need}, which is not an earlier job (jobs run in file order)`);
      }
    }
    jobs.push(read);
  }
  const env = texts(doc.env ?? {}, "env");
  for (const text of Object.values(env)) checkExpressions(text, "env");
  return { name: String(doc.name ?? ""), env, jobs };
}

/** True when a `node --version` (v22.23.1) matches an .nvmrc version (22, 22.23 or 22.23.1). */
export function nodeMatches(wanted, version) {
  const spec = String(wanted).trim().replace(/^v/, "");
  const have = String(version).trim().replace(/^v/, "").split(".");
  if (!/^\d+(\.\d+){0,2}$/.test(spec)) return false;
  return spec.split(".").every((part, k) => Number(part) === Number(have[k]));
}

/** A step's GITHUB_OUTPUT file: name=value lines and name<<END blocks. */
export function readOutputs(text) {
  const outputs = {};
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k += 1) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[k]);
    const end = heredoc ? lines.indexOf(heredoc[2], k + 1) : -1;
    const eq = lines[k].indexOf("=");
    if (heredoc && end !== -1) {
      outputs[heredoc[1]] = lines.slice(k + 1, end).join("\n");
      k = end;
    } else if (eq > 0) {
      outputs[lines[k].slice(0, eq)] = lines[k].slice(eq + 1);
    }
  }
  return outputs;
}

// ---------------------------------------------------------------------------------------------------------
// The environment steps get: this shell's, without what could point git elsewhere, reach GitHub, Cloudflare or a
// database, change npm's run, or hold a key (DL-024: the checks need no secret).

const DROPPED_TOOLS = /^(GIT|GITHUB|GH|CLOUDFLARE|CF|WRANGLER|WORKERS|NPM|MERGE_CHECK)_/i;
const DROPPED_SERVICES = /^(ANTHROPIC|OPENAI|STRIPE|LINQ|RESEND|NEON|AWS|GOOGLE|AZURE|CLAUDE|PG)/i;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL/i;
const DROPPED_NAMES = new Set([
  "CI",
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "STAGING_BASE_URL",
  "MIGRATIONS_DIR",
  "XDG_CONFIG_HOME",
  "INIT_CWD",
  "NODE_OPTIONS",
]);

/** `env` without the variables a step must not see, with git kept away from the user's own configuration. */
export function stepEnvironment(env) {
  const kept = {};
  for (const [key, value] of Object.entries(env)) {
    if (DROPPED_TOOLS.test(key) || DROPPED_SERVICES.test(key) || SECRET_NAME.test(key)) continue;
    if (DROPPED_NAMES.has(key)) continue;
    kept[key] = value;
  }
  return { ...kept, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
}

// ---------------------------------------------------------------------------------------------------------
// Running: processes, the log, the steps.

function stopGroup(child) {
  const kill = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The process group has already ended.
    }
  };
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), 10_000).unref();
}

function output(state, chunk) {
  state.out.raw(chunk);
  const lines = (state.partial + chunk.toString("utf8")).split("\n");
  state.partial = lines.pop() ?? "";
  state.tail.push(...lines);
  if (state.tail.length > TAIL_LINES) state.tail.splice(0, state.tail.length - TAIL_LINES);
}

// Runs a command in its own process group (so a stop or a timeout ends everything it started), its output to
// the log. Resolves { code, signal, timedOut, error }.
function runProcess(state, file, args, { cwd, env, deadline }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    state.child = child;
    let timedOut = false;
    const delay = Math.max(1000, deadline - Date.now());
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child);
    }, delay);
    child.stdout.on("data", (chunk) => output(state, chunk));
    child.stderr.on("data", (chunk) => output(state, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      state.child = null;
      resolve({ code: null, signal: null, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      state.child = null;
      resolve({ code, signal, timedOut, error: null });
    });
  });
}

function gitOut(state, args, { trim = true } = {}) {
  const options = { env: state.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const result = spawnSync("git", args, options);
  if (result.status !== 0) return null;
  return trim ? result.stdout.trim() : result.stdout;
}

async function git(state, args, cwd) {
  const deadline = Date.now() + 600_000;
  const result = await runProcess(state, "git", args, { cwd, env: state.env, deadline });
  if (result.code !== 0) {
    const verb = args[0] === "-C" ? args[2] : args[0];
    throw new StepError(`git ${verb} failed (${result.error ?? `exit ${result.code ?? result.signal}`})`);
  }
}

function short(state, sha) {
  if (sha === null || sha === undefined) return "none";
  const abbreviated = gitOut(state, ["--git-dir", state.sourceGitDir, "rev-parse", "--short", sha]);
  return abbreviated ?? sha.slice(0, 7);
}

const MARKS = { success: "ok", failure: "FAILED", skipped: "skipped", reused: "reused" };

// A step's line: on the console for a step that ran, in the log for every step (--verbose: everything on both).
function report(state, entry) {
  const ran = entry.status === "success" || entry.status === "failure";
  const time = ran ? `${entry.seconds.toFixed(1)} s` : "";
  const line = `  ${MARKS[entry.status].padEnd(7)} ${time.padStart(8)}  [${entry.job}] ${entry.name}`;
  const text = entry.note === undefined ? line : `${line}: ${entry.note}`;
  if (ran) state.out.say(text);
  else state.out.note(text);
  if (entry.status === "failure" && !state.args.verbose) {
    for (const tail of state.tail) process.stdout.write(`      | ${tail}\n`);
  }
}

// Runs one step: its header and command go to the log, its line to the console, its entry to the result.
async function record(state, label, name, command, action) {
  const entry = { job: label, name, command, status: "success", seconds: 0 };
  state.steps.push(entry);
  state.out.note(`\n==> [${label}] ${name}`);
  for (const line of command.split("\n")) state.out.note(`  $ ${line}`);
  state.tail = [];
  state.partial = "";
  const started = performance.now();
  try {
    const note = await action();
    if (typeof note === "string") entry.note = note;
  } catch (error) {
    entry.status = "failure";
    entry.note = messageOf(error);
    state.failed ??= { job: label, name };
    state.ok = false;
  }
  if (state.partial !== "") state.tail.push(state.partial);
  entry.seconds = Math.round((performance.now() - started) / 100) / 10;
  report(state, entry);
  return entry.status === "success";
}

function mark(state, label, step, status, note) {
  const command = step.run ?? `uses: ${step.uses}`;
  const entry = { job: label, name: step.name, command, status, seconds: 0, note };
  state.steps.push(entry);
  report(state, entry);
}

function localUrl() {
  const url = new URL(process.env.MERGE_CHECK_PG_URL ?? DEFAULT_PG_URL);
  if (!/^postgres(ql)?:$/.test(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new StepError("MERGE_CHECK_PG_URL must name a PostgreSQL server on this Mac (localhost)");
  }
  return url;
}

function runDatabaseName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase();
  return `mc_${stamp}_${randomBytes(3).toString("hex")}`;
}

// The job's postgres service: a database of this run's own on the local server, which must run the PostgreSQL
// and PostGIS versions of merge-check.yml's service image. From template_postgis, as the image makes its database.
async function createDatabase(state, label, job) {
  const base = localUrl();
  const server = `${base.hostname}:${base.port || "5432"}`;
  const sql = postgres(base.href, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    let found;
    try {
      [found] = await sql`
        select current_setting('server_version_num')::int / 10000 as major,
          (select default_version from pg_available_extensions where name = 'postgis') as postgis,
          exists (select 1 from pg_database where datname = 'template_postgis' and datistemplate) as template
      `;
    } catch (error) {
      const why = `start it with npm run db:up (${messageOf(error)})`;
      throw new StepError(`the local PostgreSQL (${server}) is not reachable: ${why}`);
    }
    const postgis = String(found.postgis ?? "none");
    const sameServer = String(found.major) === job.service.postgres;
    if (!sameServer || !`${postgis}.`.startsWith(`${job.service.postgis}.`)) {
      throw new StepError(
        `the local server runs PostgreSQL ${found.major} with PostGIS ${postgis}, but merge-check.yml's ` +
          `service is ${job.service.image}`,
      );
    }
    const name = runDatabaseName();
    const template = found.template ? "template_postgis" : "template1";
    await sql.unsafe(`create database "${name}" template "${template}"`);
    const url = new URL(base.href);
    url.pathname = `/${name}`;
    state.db = { job: label, name, server, template, url: url.href, dropped: false };
    const versions = `PostgreSQL ${found.major}, PostGIS ${postgis}`;
    return `database ${name} on ${server}, from ${template} (${versions})`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function dropDatabase(state) {
  const { name } = state.db;
  if (!RUN_DATABASE.test(name)) {
    throw new StepError(`refusing to drop ${name}: not a merge-check run database`);
  }
  const sql = postgres(localUrl().href, { max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
    const [row] = await sql`select count(*)::int as remaining from pg_database where datname = ${name}`;
    if (row.remaining !== 0) throw new StepError(`database ${name} is still there`);
    state.db.dropped = true;
    return `database ${name} dropped`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// actions/checkout, here: clone this repository's git store by path, set origin/main and the branch to what it
// holds, and check the branch out as checkout does (git checkout --force -B <branch> origin/<branch>).
async function checkout(state, label, step) {
  const branch = state.args.branch;
  const target = `refs/remotes/origin/${branch}`;
  const source = state.branchRef?.ref ?? `refs/heads/${branch}`;
  const command = [
    `git clone --no-checkout ${state.sourceGitDir} ${state.workspace}`,
    `git fetch --no-tags origin +${MAIN_REF}:${MAIN_REF} +${source}:${target}`,
    `git checkout --force -B ${branch} ${target}`,
  ].join("\n");
  return record(state, label, step.name, command, async () => {
    if (state.checkedOut) {
      throw new DriftError(`${label}: a second, different checkout; this runner checks out once`);
    }
    if (state.branchRef === null) {
      throw new StepError(`no branch ${branch} here: neither refs/heads/${branch} nor ${target}`);
    }
    const clone = ["clone", "--quiet", "--no-checkout", state.sourceGitDir, state.workspace];
    await git(state, clone, state.temp);
    const inClone = (args) => git(state, ["-C", state.workspace, ...args], state.workspace);
    // A push from the clone goes nowhere; a fetch in it keeps mirroring this repository's origin/* refs.
    await inClone(["remote", "set-url", "--push", "origin", "no-push://local-merge-check"]);
    await inClone(["config", "remote.origin.fetch", "+refs/remotes/origin/*:refs/remotes/origin/*"]);
    const refspecs = [`+${MAIN_REF}:${MAIN_REF}`, `+${source}:${target}`];
    await inClone(["fetch", "--quiet", "--no-tags", "origin", ...refspecs]);
    await inClone(["checkout", "--quiet", "--force", "-B", branch, target]);
    const main = gitOut(state, ["-C", state.workspace, "rev-parse", MAIN_REF]);
    const head = gitOut(state, ["-C", state.workspace, "rev-parse", "HEAD"]);
    if (main !== state.mainSha || head !== state.branchRef.sha) {
      throw new StepError("origin/main or the branch moved as the run started: run it again");
    }
    state.checkedOut = true;
    return `${branch} at ${short(state, head)}; origin/main at ${short(state, main)}`;
  });
}

// actions/setup-node, here: the Node on PATH must be the version the node-version-file names.
async function setupNode(state, label, step) {
  const file = step.with["node-version-file"];
  return record(state, label, step.name, `node --version, against ${file}`, () => {
    const wanted = readFileSync(path.join(state.workspace, file), "utf8").trim();
    const options = { cwd: state.workspace, env: state.env, encoding: "utf8" };
    const result = spawnSync("node", ["--version"], options);
    const version = result.status === 0 ? result.stdout.trim() : "";
    if (!nodeMatches(wanted, version)) {
      throw new StepError(`node --version is ${version || "missing"}, but ${file} asks for ${wanted}`);
    }
    return `node ${version} matches ${file} (${wanted})`;
  });
}

function jobEnv(state, job, context) {
  const env = fillAll(job.env, context);
  if (job.service !== null) {
    for (const [key, text] of Object.entries(env)) {
      if (/^postgres(ql)?:\/\//.test(text)) env[key] = state.db.url;
    }
  }
  return env;
}

// A run step, as Actions runs a bash step: the filled script in a file, `bash --noprofile --norc -eo pipefail`.
async function runStep(state, label, job, step, context, deadline) {
  state.counter += 1;
  const script = fill(step.run, context);
  const file = path.join(state.temp, `step-${state.counter}.sh`);
  const outputFile = path.join(state.temp, `step-${state.counter}.out`);
  writeFileSync(file, script);
  writeFileSync(outputFile, "");
  const env = { ...state.env, ...fillAll(state.workflow.env, context), ...jobEnv(state, job, context) };
  Object.assign(env, fillAll(step.env, context), { CI: "true" });
  Object.assign(env, { GITHUB_STEP_SUMMARY: state.summaryFile, GITHUB_OUTPUT: outputFile });
  const timedOut = `timed out: the job's timeout-minutes is ${job.minutes}`;
  const passed = await record(state, label, step.name, script.trimEnd(), async () => {
    if (deadline <= Date.now() && !step.always) throw new StepError(timedOut);
    const until = step.always ? Math.max(deadline, Date.now() + 60_000) : deadline;
    const args = ["--noprofile", "--norc", "-eo", "pipefail", file];
    const result = await runProcess(state, "bash", args, { cwd: state.workspace, env, deadline: until });
    if (result.timedOut) throw new StepError(timedOut);
    if (result.code !== 0) {
      throw new StepError(result.error ?? `exit code ${result.code ?? result.signal}`);
    }
  });
  return { passed, outputs: readOutputs(readFileSync(outputFile, "utf8")) };
}

// One step's identity: the same step, filled in, in a later job's leading steps is done once in the shared clone.
function stepKey(step, context) {
  const run = step.run === null ? null : fill(step.run, context);
  const filled = [run, fillAll(step.with, context), fillAll(step.env, context)];
  return JSON.stringify([step.name, step.uses, step.if, ...filled]);
}

async function runJobOnce(state, job, label, value, needs) {
  const deadline = Date.now() + job.minutes * 60_000;
  const matrix = job.matrix === null ? {} : { [job.matrix.key]: value };
  const steps = {};
  let ok = true;
  let leading = true;
  const contextNow = () => {
    const cancelled = state.interrupted !== null;
    const status = { status: ok ? "success" : "failure" };
    return { inputs: state.inputs, matrix, needs, steps, job: status, ok, cancelled };
  };
  if (job.service !== null && state.db === null) {
    const command = "create database <mc_ run database> template template_postgis";
    ok = await record(state, label, SERVICE_START, command, () => createDatabase(state, label, job));
    if (!ok) {
      for (const step of job.steps) mark(state, label, step, "skipped", "the service did not start");
      return { ok, outputs: {} };
    }
  }
  for (const step of job.steps) {
    const context = contextNow();
    if (state.interrupted !== null) {
      mark(state, label, step, "skipped", "interrupted");
      continue;
    }
    if (!conditionHolds(step.if, context)) {
      mark(state, label, step, "skipped", ok ? `its if: is false (${step.if})` : "an earlier step failed");
      continue;
    }
    const key = stepKey(step, context);
    leading &&= state.done.has(key);
    if (leading) {
      mark(state, label, step, "reused", "an earlier job ran the same step in this clone");
      continue;
    }
    let passed;
    let outputs = {};
    if (step.kind === "checkout") passed = await checkout(state, label, step);
    else if (step.kind === "setup-node") passed = await setupNode(state, label, step);
    else ({ passed, outputs } = await runStep(state, label, job, step, context, deadline));
    if (step.id !== null) {
      const outcome = passed ? "success" : "failure";
      steps[step.id] = { outputs, outcome, conclusion: outcome };
    }
    if (passed) state.done.add(key);
    else ok = false;
  }
  return { ok, outputs: fillAll(job.outputs, contextNow()) };
}

function skipJob(state, job, why) {
  for (const step of job.steps) mark(state, job.id, step, "skipped", why);
  state.needs[job.id] = { result: "skipped", outputs: {} };
  state.jobs.push({ id: job.id, matrix: null, result: "skipped" });
}

async function runJobs(state) {
  for (const job of state.workflow.jobs) {
    const needs = {};
    for (const need of job.needs) needs[need] = state.needs[need];
    if (!state.ok || state.interrupted !== null) {
      skipJob(state, job, state.interrupted === null ? "an earlier step failed" : "interrupted");
      continue;
    }
    const ok = job.needs.every((need) => needs[need].result === "success");
    if (!conditionHolds(job.if, { inputs: state.inputs, needs, ok })) {
      skipJob(state, job, `its if: is false (${job.if ?? "success()"})`);
      continue;
    }
    let result = "success";
    let outputs = {};
    for (const value of job.matrix === null ? [null] : job.matrix.values) {
      const label = job.matrix === null ? job.id : `${job.id} ${job.matrix.key}=${value}`;
      if ((result === "failure" && job.matrix.failFast) || state.interrupted !== null) {
        for (const step of job.steps) mark(state, label, step, "skipped", "fail-fast or interrupted");
        continue;
      }
      const once = await runJobOnce(state, job, label, value, needs);
      state.jobs.push({ id: job.id, matrix: value, result: once.ok ? "success" : "failure" });
      if (!once.ok) result = "failure";
      outputs = once.outputs;
    }
    state.needs[job.id] = { result, outputs };
  }
}

async function runAll(state) {
  const name = "Read merge-check.yml at origin/main";
  const read = await record(state, "local", name, `git show origin/main:${WORKFLOW_FILE}`, () => {
    const verify = ["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`];
    state.mainSha = gitOut(state, ["--git-dir", state.sourceGitDir, ...verify]);
    if (state.mainSha === null) {
      throw new StepError("origin/main is missing here: run git fetch origin first");
    }
    const show = ["--git-dir", state.sourceGitDir, "show", `${state.mainSha}:${WORKFLOW_FILE}`];
    const text = gitOut(state, show, { trim: false });
    if (text === null) throw new StepError(`origin/main has no ${WORKFLOW_FILE}`);
    state.workflow = readWorkflow(text);
    const jobs = state.workflow.jobs.map((job) => job.id).join(", ");
    return `origin/main ${short(state, state.mainSha)}; jobs ${jobs}`;
  });
  if (read) await runJobs(state);
}

// After the run, pass or fail: note the rebased commit, drop the database, remove the clone, write the result.
async function finish(state) {
  if (state.checkedOut) {
    const head = gitOut(state, ["-C", state.workspace, "rev-parse", "HEAD"]);
    const ancestor = ["-C", state.workspace, "merge-base", "--is-ancestor", MAIN_REF, "HEAD"];
    const based = spawnSync("git", ancestor, { env: state.env });
    state.rebased = based.status === 0 ? head : null;
  }
  if (state.db !== null) {
    const command = `drop database "${state.db.name}" with (force)`;
    await record(state, state.db.job, SERVICE_STOP, command, () => dropDatabase(state));
  }
  try {
    rmSync(state.temp, { recursive: true, force: true });
  } catch (error) {
    state.out.say(`merge-check: could not remove ${state.temp}: ${messageOf(error)}`);
  }
  const passed = state.ok && state.interrupted === null;
  const finished = new Date();
  const database = state.db === null ? null : { name: state.db.name, server: state.db.server };
  const result = {
    branch: state.args.branch,
    branch_ref: state.branchRef?.ref ?? null,
    branch_head: state.branchRef?.sha ?? null,
    origin_main: state.mainSha,
    rebased_commit: state.rebased,
    ai_change: state.args.aiChange,
    result: passed ? "success" : "failure",
    failed_step: state.failed,
    interrupted: state.interrupted,
    started_at: state.started.toISOString(),
    finished_at: finished.toISOString(),
    seconds: Math.round((finished.getTime() - state.started.getTime()) / 100) / 10,
    repository: state.sourceGitDir,
    workflow: `${WORKFLOW_FILE} at origin/main`,
    database: database === null ? null : { ...database, dropped: state.db.dropped },
    log: state.logFile,
    summary: state.summaryFile,
    jobs: state.jobs,
    steps: state.steps,
  };
  writeFileSync(state.resultFile, `${JSON.stringify(result, null, 2)}\n`);
  const count = (status) => state.steps.filter((entry) => entry.status === status).length;
  const counts = `${count("success")} passed, ${count("failure")} failed`;
  state.out.say(`merge-check: steps ${counts}, ${count("skipped")} skipped, ${count("reused")} reused`);
  const head = short(state, state.branchRef?.sha);
  const rebased = state.rebased === null ? "not rebased" : `rebased as ${short(state, state.rebased)}`;
  const onto = `origin/main ${short(state, state.mainSha)}`;
  state.out.say(`merge-check: ${result.result}: ${state.args.branch} at ${head} onto ${onto}, ${rebased}`);
  state.out.say(`merge-check: result ${state.resultFile}`);
  await state.out.close();
}

function parseArgs(argv) {
  const args = { branch: null, aiChange: false, verbose: false, repo: REPO, outDir: null };
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === "--ai-change") {
      args.aiChange = true;
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--repo" || arg === "--out-dir") {
      const value = argv[k + 1];
      if (value === undefined || value === "") throw new UsageError(`${arg} needs a path`);
      k += 1;
      if (arg === "--repo") args.repo = path.resolve(value);
      else args.outDir = path.resolve(value);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (args.branch === null) {
      args.branch = arg;
    } else {
      throw new UsageError(`one branch only, not ${args.branch} and ${arg}`);
    }
  }
  if (args.branch === null) throw new UsageError("name the branch to check");
  args.outDir ??= path.join(REPO, "scratch", "ci");
  return args;
}

// The branch in the repository: its own branch, else its origin/ ref. Only for a plain name (the YAML's branch
// check judges the name itself, as its first step).
function resolveBranch(state, branch) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) return null;
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const verify = ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
    const sha = gitOut(state, ["--git-dir", state.sourceGitDir, ...verify]);
    if (sha !== null) return { ref, sha };
  }
  return null;
}

function folderName(branch) {
  const plain = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const name = plain.replace(/\.{2,}/g, "-").replace(/^[-.]+/, "");
  return name.slice(0, 80) || "branch";
}

function openLog(file, verbose) {
  const stream = createWriteStream(file, { flags: "w" });
  return {
    say(line) {
      process.stdout.write(`${line}\n`);
      stream.write(`${line}\n`);
    },
    note(line) {
      stream.write(`${line}\n`);
      if (verbose) process.stdout.write(`${line}\n`);
    },
    raw(chunk) {
      stream.write(chunk);
      if (verbose) process.stdout.write(chunk);
    },
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}

/** Runs the merge-check for argv ([branch, flags]); resolves the exit code. */
export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`merge-check: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  const env = stepEnvironment(process.env);
  const options = { env, encoding: "utf8" };
  const common = spawnSync("git", ["-C", args.repo, "rev-parse", "--git-common-dir"], options);
  if (common.status !== 0) {
    process.stderr.write(`merge-check: ${args.repo} is not a git repository\n`);
    return 2;
  }
  const state = { args, env, sourceGitDir: path.resolve(args.repo, common.stdout.trim()) };
  state.branchRef = resolveBranch(state, args.branch);
  const folder = `${folderName(args.branch)}-${short(state, state.branchRef?.sha)}`;
  mkdirSync(path.join(args.outDir, folder), { recursive: true });
  state.temp = realpathSync(mkdtempSync(path.join(tmpdir(), "rosie-merge-check-")));
  state.workspace = path.join(state.temp, "workspace");
  mkdirSync(state.workspace);
  Object.assign(state, {
    inputs: { branch: args.branch, ai_change: args.aiChange },
    logFile: path.join(args.outDir, folder, "merge-check.log"),
    resultFile: path.join(args.outDir, folder, "result.json"),
    summaryFile: path.join(args.outDir, folder, "summary.md"),
    started: new Date(),
    steps: [],
    jobs: [],
    needs: {},
    done: new Set(),
    counter: 0,
    tail: [],
    partial: "",
    ok: true,
    failed: null,
    interrupted: null,
    child: null,
    db: null,
    mainSha: null,
    rebased: null,
    checkedOut: false,
    workflow: null,
  });
  rmSync(state.resultFile, { force: true });
  writeFileSync(state.summaryFile, "");
  state.out = openLog(state.logFile, args.verbose);
  const where = state.branchRef === null ? "not found here" : state.branchRef.ref;
  state.out.say(`merge-check: ${args.branch} (${where}) from ${state.sourceGitDir}`);
  state.out.say(`merge-check: full log ${state.logFile}`);
  const onSignal = (signal) => {
    if (state.interrupted !== null) return;
    state.interrupted = signal;
    state.out.say(`merge-check: ${signal}: stopping, then dropping the database and removing the clone`);
    if (state.child !== null) stopGroup(state.child);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);
  try {
    await runAll(state);
  } catch (error) {
    state.ok = false;
    state.failed ??= { job: "local", name: "the runner" };
    state.out.say(`merge-check: stopped by an error: ${messageOf(error)}`);
  } finally {
    await finish(state);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, onSignal);
  }
  if (state.interrupted !== null) return 130;
  return state.ok ? 0 : 1;
}

const invoked = process.argv[1] === undefined ? "" : realpathSync(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
