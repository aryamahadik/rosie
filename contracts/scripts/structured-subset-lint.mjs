#!/usr/bin/env node
// Structured-outputs subset lint (T-011; 02-contracts section 2 item 7; contracts/README.md convention 7).
// `npm run contracts:check` runs it after check-fixtures.mjs. ES module; uses ajv from the root manifest.
//
// The model answers in a schema the model API's structured outputs must accept. Anthropic's structured-outputs
// documentation (read 2026-11-07 by T-360; its live check waits on J-02) gives the subset this lint holds each
// model-facing schema to:
//   - external $ref is refused, so the schema is BUNDLED first: every $ref, local or into another contract file, is
//     resolved and the target copied into the bundled schema's own $defs. The contract file may keep relative $refs;
//     the lint checks the bundled form, the one the AI gateway sends.
//   - supported keywords only: type, enum (of scalars), const, anyOf, allOf (never with $ref), $ref and $defs (local),
//     properties, required, additionalProperties (false only, and on every object), items (one schema), minItems (0 or
//     1 only), pattern (simple), format (date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid), and
//     the notes description, title and default. So no recursive schemas, no number limits, no string-length limits and
//     no other array limits.
//   - a simple pattern: no backreference, lookahead, lookbehind or word boundary, no open {n,} and no bound over 100.
//   - per-request limits: at most 24 optional properties and 16 parameters with a union type (anyOf, or a type array).
//     One request carries one of these schemas, so each is held to them alone. Each $defs entry is counted once.
//   - the root is an object.
//
// MODEL_FACING lists the schemas it checks: K-02's decide read, safety read and planner output. K-03's message plan
// (T-012) joins the list in a follow-up once both have merged.
//
// Usage: node scripts/structured-subset-lint.mjs [--contracts <dir>]   Exit code: 0 passed, 1 failed.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACTS_DIR, createAjv, readJson } from "./lib.mjs";

/** The model-facing output schemas this lint checks: a contract schema file and the definition the model answers in. */
export const MODEL_FACING = Object.freeze([
  { schema: "model/model.v1.schema.json", def: "decideRead", what: "K-02 decide read (arch 03 line 183)" },
  { schema: "model/model.v1.schema.json", def: "safetyRead", what: "K-02 safety read (arch 03 line 183)" },
  { schema: "model/model.v1.schema.json", def: "plannerOutput", what: "K-02 planner (arch 06 line 291)" },
]);

/** Per-request limits across the structured schemas of one request (T-360 finding 2). */
export const LIMITS = Object.freeze({ optionalProperties: 24, unionParameters: 16 });

const ALLOWED_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "$ref",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "pattern",
  "format",
  "description",
  "title",
  "default",
]);
const ALLOWED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);
const JSON_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const LARGEST_BOUND = 100;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const decodePointer = (token) => token.replace(/~1/g, "/").replace(/~0/g, "~");

function atPointer(document, pointer, where) {
  if (pointer === "" || pointer === "/") return document;
  let node = document;
  for (const token of pointer.replace(/^\//, "").split("/").map(decodePointer)) {
    if (!isObject(node) && !Array.isArray(node)) throw new Error(`${where}: ${pointer} does not resolve`);
    node = node[token];
    if (node === undefined) throw new Error(`${where}: ${pointer} does not resolve`);
  }
  return node;
}

/**
 * Bundles one definition of a contract schema into a standalone schema whose every $ref is local ("#/$defs/<key>"),
 * as the AI gateway must send it (T-360 finding 1). A $ref back to the definition itself becomes "#", which the lint
 * reports as recursion.
 * @param {{ contractsDir?: string, schema: string, def: string }} target  schema: path inside contracts/
 * @returns {object} the bundled schema
 */
export function bundleSchema({ contractsDir = CONTRACTS_DIR, schema, def }) {
  const documents = new Map();
  const load = (file) => {
    if (!documents.has(file)) {
      const absolute = path.join(contractsDir, file);
      if (!existsSync(absolute)) throw new Error(`${file} does not exist`);
      documents.set(file, readJson(absolute, file));
    }
    return documents.get(file);
  };
  const rootPointer = `/$defs/${def}`;
  const rootId = `${schema}#${rootPointer}`;
  const keys = new Map([[rootId, ""]]); // file#pointer -> key in the bundled $defs ("" is the root)
  const usedKeys = new Set();
  const queue = [];
  const keyFor = (file, pointer) => {
    const id = `${file}#${pointer}`;
    if (!keys.has(id)) {
      const tokens = pointer.split("/").filter(Boolean).map(decodePointer);
      const stem = path.posix
        .basename(file)
        .replace(/\.schema\.json$/, "")
        .replace(/[^A-Za-z0-9]+/g, "_");
      const last = tokens.length > 0 ? tokens[tokens.length - 1] : stem;
      let key = last.replace(/[^A-Za-z0-9_.-]+/g, "_");
      if (usedKeys.has(key))
        key = `${stem}.${tokens.map((t) => t.replace(/[^A-Za-z0-9_-]+/g, "_")).join(".")}`;
      while (usedKeys.has(key)) key = `${key}_`;
      usedKeys.add(key);
      keys.set(id, key);
      queue.push({ file, pointer, key });
    }
    return keys.get(id);
  };
  const rewrite = (node, file) => {
    if (Array.isArray(node)) return node.map((item) => rewrite(item, file));
    if (!isObject(node)) return node;
    const out = {};
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === "$schema" || keyword === "$id") continue;
      if (keyword === "$ref" && typeof value === "string") {
        const [filePart, pointer = ""] = value.split("#");
        const targetFile =
          filePart === "" ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), filePart));
        const key = keyFor(targetFile, pointer);
        out.$ref = key === "" ? "#" : `#/$defs/${key}`;
      } else if (keyword === "properties" && isObject(value)) {
        out.properties = Object.fromEntries(
          Object.entries(value).map(([name, sub]) => [name, rewrite(sub, file)]),
        );
      } else if (
        keyword === "enum" ||
        keyword === "const" ||
        keyword === "default" ||
        keyword === "required"
      ) {
        out[keyword] = value;
      } else {
        out[keyword] = rewrite(value, file);
      }
    }
    return out;
  };
  const root = rewrite(atPointer(load(schema), rootPointer, schema), schema);
  const defs = {};
  while (queue.length > 0) {
    const { file, pointer, key } = queue.shift();
    defs[key] = rewrite(atPointer(load(file), pointer, file), file);
  }
  return Object.keys(defs).length === 0 ? root : { ...root, $defs: defs };
}

/** Problems a pattern has for the subset: backreferences, lookarounds, word boundaries, open or large bounds. */
export function patternProblems(pattern) {
  const problems = [];
  let inClass = false;
  for (let k = 0; k < pattern.length; k += 1) {
    const c = pattern[k];
    if (c === "\\") {
      const next = pattern[k + 1] ?? "";
      if (/[1-9]/.test(next) || next === "k") problems.push("a backreference");
      if (!inClass && (next === "b" || next === "B")) problems.push("a word boundary");
      k += 1;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(" && pattern[k + 1] === "?") {
      if (pattern[k + 2] === "=" || pattern[k + 2] === "!") problems.push("a lookahead");
      if (pattern[k + 2] === "<" && (pattern[k + 3] === "=" || pattern[k + 3] === "!"))
        problems.push("a lookbehind");
    } else if (c === "{") {
      const bound = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(k));
      if (bound !== null) {
        if (bound[2] !== undefined && bound[3] === "") problems.push(`an open bound ${bound[0]}`);
        const largest = Math.max(Number(bound[1]), bound[3] ? Number(bound[3]) : 0);
        if (largest > LARGEST_BOUND) problems.push(`a bound over ${LARGEST_BOUND} ${bound[0]}`);
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * Lints one bundled schema against the subset.
 * @returns {{ errors: string[], counts: { optionalProperties: number, unionParameters: number } }}
 */
export function lintSchema(bundled) {
  const errors = [];
  const counts = { optionalProperties: 0, unionParameters: 0 };
  const edges = new Map(); // "" (root) or a $defs key -> keys it refers to
  const fail = (where, message) => errors.push(`${where}: ${message}`);

  const walk = (node, where, owner) => {
    if (!isObject(node)) {
      fail(where, "a schema here must be an object (boolean schemas are outside the subset)");
      return;
    }
    for (const keyword of Object.keys(node)) {
      if (keyword === "$defs" && where === "#") continue;
      if (!ALLOWED_KEYWORDS.has(keyword))
        fail(where, `"${keyword}" is outside the structured-outputs subset`);
    }
    const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
    for (const type of types)
      if (!JSON_TYPES.has(type)) fail(where, `"type" ${JSON.stringify(type)} is not a JSON type`);
    if (Array.isArray(node.type) && node.type.length > 1) counts.unionParameters += 1;
    if (Array.isArray(node.anyOf)) {
      counts.unionParameters += 1;
      node.anyOf.forEach((sub, k) => walk(sub, `${where}/anyOf/${k}`, owner));
    } else if (node.anyOf !== undefined) fail(where, '"anyOf" must be an array');
    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((sub, k) => {
        if (isObject(sub) && sub.$ref !== undefined)
          fail(`${where}/allOf/${k}`, '"allOf" with "$ref" is not supported');
        walk(sub, `${where}/allOf/${k}`, owner);
      });
    } else if (node.allOf !== undefined) fail(where, '"allOf" must be an array');
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum)) fail(where, '"enum" must be an array');
      else if (node.enum.some((value) => value !== null && typeof value === "object")) {
        fail(where, '"enum" holds only strings, numbers, booleans or null (no complex values)');
      }
    }
    if (node.const !== undefined && node.const !== null && typeof node.const === "object") {
      fail(where, '"const" holds only a string, number, boolean or null');
    }
    if (node.$ref !== undefined) {
      if (node.$ref === "#") fail(where, "refers to the root: a recursive schema");
      else if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/$defs/")) {
        fail(where, `"$ref" ${JSON.stringify(node.$ref)} is not local to the bundled schema`);
      } else {
        const key = decodePointer(node.$ref.slice("#/$defs/".length));
        if (bundled.$defs?.[key] === undefined) fail(where, `"$ref" ${node.$ref} does not resolve`);
        else edges.get(owner).add(key);
      }
    }
    const isObjectSchema = types.includes("object") || node.properties !== undefined;
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      fail(where, '"additionalProperties" may only be false');
    } else if (isObjectSchema && node.additionalProperties !== false) {
      fail(where, 'an object must set "additionalProperties": false');
    }
    if (node.properties !== undefined) {
      if (!isObject(node.properties)) fail(where, '"properties" must be an object');
      else {
        const required = new Set(Array.isArray(node.required) ? node.required : []);
        for (const name of required) {
          if (!(name in node.properties))
            fail(where, `"required" names ${name}, which "properties" does not hold`);
        }
        for (const [name, sub] of Object.entries(node.properties)) {
          if (!required.has(name)) counts.optionalProperties += 1;
          walk(sub, `${where}/properties/${name}`, owner);
        }
      }
    }
    if (node.items !== undefined) {
      if (Array.isArray(node.items))
        fail(where, '"items" must be one schema (tuples are outside the subset)');
      else walk(node.items, `${where}/items`, owner);
    }
    if (node.minItems !== undefined && node.minItems !== 0 && node.minItems !== 1) {
      fail(where, `"minItems" ${JSON.stringify(node.minItems)}: only 0 or 1 is supported`);
    }
    if (node.format !== undefined && !ALLOWED_FORMATS.has(node.format)) {
      fail(where, `"format" ${JSON.stringify(node.format)} is not one the subset supports`);
    }
    if (node.pattern !== undefined) {
      if (typeof node.pattern !== "string") fail(where, '"pattern" must be a string');
      else for (const problem of patternProblems(node.pattern)) fail(where, `"pattern" has ${problem}`);
    }
  };

  edges.set("", new Set());
  for (const key of Object.keys(bundled.$defs ?? {})) edges.set(key, new Set());
  if (bundled.type !== "object") fail("#", 'the root must be "type": "object"');
  walk(bundled, "#", "");
  for (const [key, sub] of Object.entries(bundled.$defs ?? {})) walk(sub, `#/$defs/${key}`, key);

  // Recursion: a cycle among the $defs.
  const state = new Map(); // key -> "open" | "done"
  const stack = [];
  const visit = (key) => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "open") {
      const cycle = [...stack.slice(stack.indexOf(key)), key].map((k) => k || "#");
      fail(`#/$defs/${key}`, `a recursive schema: ${cycle.join(" -> ")}`);
      return;
    }
    state.set(key, "open");
    stack.push(key);
    for (const next of edges.get(key) ?? []) visit(next);
    stack.pop();
    state.set(key, "done");
  };
  for (const key of edges.keys()) visit(key);

  if (counts.optionalProperties > LIMITS.optionalProperties) {
    fail(
      "#",
      `${counts.optionalProperties} optional properties, over the limit of ${LIMITS.optionalProperties}`,
    );
  }
  if (counts.unionParameters > LIMITS.unionParameters) {
    fail(
      "#",
      `${counts.unionParameters} parameters with a union type, over the limit of ${LIMITS.unionParameters}`,
    );
  }
  return { errors: [...new Set(errors)], counts };
}

/**
 * Bundles and lints every model-facing schema; also checks that each bundled form compiles in Ajv (strict).
 * @returns {{ name: string, bundled?: object, errors: string[], counts?: object }[]}
 */
export function lintModelFacing({ contractsDir = CONTRACTS_DIR, targets = MODEL_FACING } = {}) {
  return targets.map(({ schema, def }) => {
    const name = `${schema}#/$defs/${def}`;
    let bundled;
    try {
      bundled = bundleSchema({ contractsDir, schema, def });
    } catch (error) {
      return { name, errors: [`cannot bundle: ${error.message}`] };
    }
    const { errors, counts } = lintSchema(bundled);
    try {
      createAjv().compile(bundled);
    } catch (error) {
      errors.push(`the bundled form does not compile: ${error.message}`);
    }
    return { name, bundled, errors, counts };
  });
}

/** Runs the lint; returns the exit code. */
export function main(argv, { write = (line) => console.log(line) } = {}) {
  let contractsDir = CONTRACTS_DIR;
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--contracts" && argv[k + 1] !== undefined) {
      contractsDir = path.resolve(argv[k + 1]);
      k += 1;
    } else {
      write(
        `FAIL unknown argument "${argv[k]}". Usage: node scripts/structured-subset-lint.mjs [--contracts <dir>]`,
      );
      return 1;
    }
  }
  let problems = 0;
  for (const result of lintModelFacing({ contractsDir })) {
    const tally = result.counts
      ? ` (${result.counts.optionalProperties} optional properties of ${LIMITS.optionalProperties}, ` +
        `${result.counts.unionParameters} union parameters of ${LIMITS.unionParameters})`
      : "";
    write(
      `structured-subset lint: ${result.name}${tally}: ${result.errors.length === 0 ? "passed" : "FAILED"}`,
    );
    for (const line of result.errors) write(`FAIL ${result.name} ${line}`);
    problems += result.errors.length;
  }
  if (problems === 0) {
    write(`structured-subset lint: passed (${MODEL_FACING.length} model-facing schemas)`);
    return 0;
  }
  write(`structured-subset lint: FAILED (${problems} problem${problems === 1 ? "" : "s"})`);
  return 1;
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
