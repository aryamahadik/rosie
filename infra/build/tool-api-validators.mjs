#!/usr/bin/env node
// The Tool API's schema checks, compiled ahead of time for the Worker (T-1144; DL-327; ADR-005):
// `npm run build:validators`. ES module, so strict mode is on.
//
// Ajv compiles a schema with new Function, which the Workers runtime refuses (actions/README.md, open point "Ajv in
// the Worker"). So this build compiles, here in Node, exactly the definitions actions/src/tool-api/validator.ts checks:
// `$defs/<call>.request`, `.response` and `.errors` of K-09 v1 for each call of its `$defs/callName`, and `$defs/span`
// of K-08 v1.1, with every schema their $refs reach, read from contracts/ on disk (nothing is fetched). It uses
// validator.ts's Ajv: the 2020-12 class in strict mode with the same options, so the code is the code Ajv's compiler
// runs in Node. Ajv writes it out as standalone code (ajv/dist/standalone): plain JavaScript that needs no compiler,
// so nothing is evaluated at run time. The run-time helpers it calls (ajv/dist/runtime) are imported, and the bundler
// takes them from node_modules, so ajv stays a devDependency.
//
// It writes into actions/src/tool-api/generated/, which is git-ignored, never edited and never committed (ADR-005):
//   validators.js     the standalone code: one validate function per definition, `definitions` (each by its $ref)
//                     and `build` (Ajv's version, the options, the schema ids and files, each file's sha256);
//   validators.d.ts   its types;
//   ajv-answers.js    what Ajv's compiler itself answers here in Node, with validator.ts's options, to each check on
//                     the contracts' own fixtures (each K-09 fixture of a K-09 v1 call, every version, and each K-08
//                     span fixture) and on {} for each definition. validator.worker.test.ts holds the code to these
//                     answers inside workerd, where the compiler cannot run;
//   ajv-answers.d.ts  its types.
// Then it loads validators.js in this Node and checks that it gives every one of those answers. If not, it removes
// what it wrote and fails, so no code that differs from the compiler's is ever left in place.
//
// It runs before lint, the type check, the tests and the staging deploy: `npm run contracts:types` runs it after the
// contract types (the step ci.yml and merge-check.yml, and so the local merge-check, run before lint and the type
// check), and `npm test`, `npm run test:<project>`, `npm run test:count` and `npm run deploy:staging` run it first
// (their pre scripts in package.json), so no test and no staging bundle runs stale or missing code.
//
// Usage: node infra/build/tool-api-validators.mjs [--out <dir>]
// Exit code: 0 written, 1 failed.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CONTRACTS_DIR = path.join(ROOT, "contracts");
export const DEFAULT_OUT = path.join(ROOT, "actions", "src", "tool-api", "generated");

/** validator.ts's Ajv options (T-290; 02-contracts section 2 item 8): strict mode, every error. */
export const AJV_OPTIONS = Object.freeze({ strict: true, strictRequired: false, allErrors: true });

/** K-09 v1 and K-08 v1.1, the two schemas validator.ts checks against, relative to contracts/. */
export const TOOL_API_FILE = "tool-api/tool-api.v1.schema.json";
export const EVENT_TRACE_FILE = "event-trace/event-trace.v1.1.schema.json";

/** The three definitions of every call under $defs (02-contracts section 2 item 2): validator.ts's CallPart. */
export const PARTS = Object.freeze(["request", "response", "errors"]);

/** The fixture indexes the answers are taken on, relative to contracts/. */
const TOOL_API_INDEX = "tool-api/fixtures/index.json";
const EVENT_TRACE_INDEX = "event-trace/fixtures/index.json";

/** Where a $ref names another contract by its $id (contracts/README.md convention 2), not by a relative path. */
const ID_PREFIX = "https://rosie.invalid/contracts/";

/**
 * Ajv's run-time helpers the code may import. Each is a function, which a bundler hands over as the CommonJS module's
 * default export and Node as `module.exports.default`; the code takes it either way (`helper` below). Any other helper
 * fails the build rather than being guessed at.
 */
const HELPERS = new Set(["ucs2length", "equal"]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const readJson = (contractsDir, file) =>
  JSON.parse(readFileSync(path.join(contractsDir, ...file.split("/")), "utf8"));

/** The files a schema's $refs name, relative to contracts/ (a $ref inside the same file names none). */
function referencedFiles(file, schema) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref" && typeof inner === "string") {
          const target = inner.split("#")[0];
          if (target.startsWith(ID_PREFIX)) found.push(target.slice(ID_PREFIX.length));
          else if (/^[a-z]+:/i.test(target))
            throw new Error(`${file} refers to ${target}, outside contracts/`);
          else if (target !== "") found.push(path.posix.join(path.posix.dirname(file), target));
        } else {
          walk(inner);
        }
      }
    }
  };
  walk(schema);
  return found;
}

/** K-09 v1, K-08 v1.1 and every schema file their $refs reach, each with its text's sha256, sorted by file. */
export function readSchemas(contractsDir = CONTRACTS_DIR) {
  const read = new Map();
  const queue = [TOOL_API_FILE, EVENT_TRACE_FILE];
  while (queue.length > 0) {
    const file = queue.shift();
    if (read.has(file)) continue;
    const text = readFileSync(path.join(contractsDir, ...file.split("/")), "utf8");
    const schema = JSON.parse(text);
    read.set(file, { file, schema, sha256: createHash("sha256").update(text).digest("hex") });
    queue.push(...referencedFiles(file, schema));
  }
  return [...read.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Each definition the code holds, as { exportName, ref }: K-09's in callName's order, then K-08's span. */
export function definitionsOf(schemas) {
  const toolApi = schemas.find((entry) => entry.file === TOOL_API_FILE)?.schema;
  const eventTrace = schemas.find((entry) => entry.file === EVENT_TRACE_FILE)?.schema;
  const calls = toolApi?.$defs?.callName?.enum;
  if (!Array.isArray(calls) || calls.length === 0)
    throw new Error(`${TOOL_API_FILE} has no $defs/callName list`);
  const definitions = [];
  for (const call of calls) {
    for (const part of PARTS) {
      const name = `${call}.${part}`;
      if (toolApi.$defs[name] === undefined) throw new Error(`${TOOL_API_FILE} has no definition ${name}`);
      definitions.push({ exportName: `${call}_${part}`, ref: `${toolApi.$id}#/$defs/${name}` });
    }
  }
  if (eventTrace?.$defs?.span === undefined) throw new Error(`${EVENT_TRACE_FILE} has no definition span`);
  definitions.push({ exportName: "span", ref: `${eventTrace.$id}#/$defs/span` });
  for (const { exportName } of definitions) {
    if (!IDENTIFIER.test(exportName)) throw new Error(`${exportName} cannot be an export name`);
  }
  return definitions;
}

function ajvWith(schemas, options) {
  const ajv = new Ajv2020(options);
  for (const { schema } of schemas) ajv.addSchema(schema);
  return ajv;
}

/**
 * Ajv's standalone code for the definitions, as an ES module whose run-time helpers are imports: Ajv writes each as
 * `require("ajv/dist/runtime/<name>").default`, which an ES module cannot run.
 */
export function standaloneModule(schemas, definitions) {
  const ajv = ajvWith(schemas, { ...AJV_OPTIONS, code: { source: true, esm: true, lines: true } });
  const exportNames = Object.fromEntries(definitions.map(({ exportName, ref }) => [exportName, ref]));
  const code = standaloneCode(ajv, exportNames).replace(/^"use strict";\n?/, "");
  const helpers = new Set();
  const body = code.replace(/require\("ajv\/dist\/runtime\/([a-z0-9_]+)"\)\.default/g, (_, name) => {
    if (!HELPERS.has(name))
      throw new Error(`the code needs Ajv's run-time helper ${name}, which this build does not ship`);
    helpers.add(name);
    return `runtime_${name}`;
  });
  // A require Ajv wrote is code, require("...") (a schema's own words sit in JSON strings, their quotes escaped).
  if (/\brequire\("/.test(body))
    throw new Error("the code requires a module other than Ajv's run-time helpers");
  const imports = [...helpers]
    .sort()
    .map((name) => `import runtime_${name}_module from "ajv/dist/runtime/${name}.js";`);
  const picks = [...helpers].sort().map((name) => `const runtime_${name} = helper(runtime_${name}_module);`);
  return { imports, picks, body, helpers: [...helpers].sort() };
}

/** One Ajv error as JSON: what validator.ts's problem lines are made of. */
const plain = (errors) => JSON.parse(JSON.stringify(errors ?? []));

/**
 * What Ajv's compiler answers in Node, with validator.ts's options: each check as { source, pick, definition, valid,
 * errors }, and the fixtures it reads by source (a file relative to contracts/). `pick` is the part of the fixture
 * checked: "request" or "outcome" of an exchange, or null for the whole file; a source of null is {}.
 */
export function ajvAnswers(schemas, definitions, contractsDir = CONTRACTS_DIR) {
  const ajv = ajvWith(schemas, AJV_OPTIONS);
  const toolApi = schemas.find((entry) => entry.file === TOOL_API_FILE).schema;
  const refs = new Set(definitions.map(({ ref }) => ref));
  const calls = new Set(toolApi.$defs.callName.enum);
  const fixtures = {};
  const checks = [];
  const check = (entry, source, pick, ref) => {
    const validate = ajv.getSchema(ref);
    if (validate === undefined || !refs.has(ref)) throw new Error(`no definition ${ref}`);
    const document = source === null ? {} : fixtures[source];
    const value = pick === null ? document : document[pick];
    const valid = validate(value);
    checks.push({
      ...entry,
      source,
      pick,
      definition: ref,
      valid,
      errors: valid ? [] : plain(validate.errors),
    });
  };

  const toolApiRef = (name) => `${toolApi.$id}#/$defs/${name}`;
  for (const entry of readJson(contractsDir, TOOL_API_INDEX).fixtures) {
    const [call, part] = entry.def.split(".");
    if (!calls.has(call) || !(part === "exchange" || PARTS.includes(part))) continue;
    const source = `tool-api/fixtures/${entry.file}`;
    fixtures[source] = readJson(contractsDir, source);
    const about = { version: entry.version, def: entry.def, expect: entry.expect };
    if (part === "exchange") {
      check(about, source, "request", toolApiRef(`${call}.request`));
      check(about, source, "outcome", toolApiRef(`${call}.response`));
      check(about, source, "outcome", toolApiRef(`${call}.errors`));
    } else {
      check(about, source, null, toolApiRef(entry.def));
    }
  }
  const spanRef = definitions.at(-1).ref;
  for (const entry of readJson(contractsDir, EVENT_TRACE_INDEX).fixtures) {
    if (entry.def !== "span") continue;
    const source = `event-trace/fixtures/${entry.file}`;
    fixtures[source] = readJson(contractsDir, source);
    check({ version: entry.version, def: entry.def, expect: entry.expect }, source, null, spanRef);
  }
  for (const { ref } of definitions) check({ version: null, def: null, expect: null }, null, null, ref);
  return { fixtures, checks };
}

const json = (value) => JSON.stringify(value, null, 2);

function validatorsJs(schemas, definitions, generated) {
  const ajvVersion = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("ajv/package.json")), "utf8"));
  const build = {
    ajv: ajvVersion.version,
    options: AJV_OPTIONS,
    toolApiSchemaId: schemas.find((entry) => entry.file === TOOL_API_FILE).schema.$id,
    eventTraceSchemaId: schemas.find((entry) => entry.file === EVENT_TRACE_FILE).schema.$id,
    schemaFiles: schemas.map(({ file }) => file),
    sha256: Object.fromEntries(schemas.map(({ file, sha256 }) => [file, sha256])),
    helpers: generated.helpers,
  };
  const table = definitions
    .map(({ exportName, ref }) => `  ${JSON.stringify(ref)}: ${exportName},`)
    .join("\n");
  return [
    "// Generated by infra/build/tool-api-validators.mjs (npm run build:validators) from contracts/: Ajv's standalone",
    "// code for the definitions actions/src/tool-api/validator.ts checks. Git-ignored: never edit or commit (ADR-005).",
    ...generated.imports,
    "",
    "/** Ajv's run-time helper: a bundler gives the CommonJS module's default export, Node gives module.exports. */",
    'const helper = (module) => (typeof module === "function" ? module : module.default);',
    ...generated.picks,
    "",
    generated.body,
    "",
    "/** Each definition's validate function, by its $ref. */",
    `export const definitions = Object.freeze({\n${table}\n});`,
    "",
    "/** What this code was built from. */",
    `export const build = Object.freeze(${json(build)});`,
    "",
  ].join("\n");
}

const VALIDATORS_D_TS = `// Generated by infra/build/tool-api-validators.mjs (npm run build:validators): the types of validators.js.
// Git-ignored: never edit or commit (ADR-005).
import type { ErrorObject } from "ajv";

/** One of Ajv's standalone validate functions: true when the value passes; when not, its errors are on \`errors\`. */
export interface StandaloneValidate {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

/** Each definition's validate function, by its $ref: the schema's $id, "#/$defs/" and the definition's name. */
export declare const definitions: Readonly<Record<string, StandaloneValidate>>;

/** What validators.js was built from. */
export declare const build: {
  readonly ajv: string;
  readonly options: Readonly<Record<string, boolean>>;
  readonly toolApiSchemaId: string;
  readonly eventTraceSchemaId: string;
  readonly schemaFiles: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
  readonly helpers: readonly string[];
};
`;

function answersJs(answers) {
  return [
    "// Generated by infra/build/tool-api-validators.mjs (npm run build:validators): what Ajv's compiler answers in Node",
    "// to each check on the contracts' fixtures and on {}. Git-ignored: never edit or commit (ADR-005).",
    `export const ajvAnswers = ${json(answers)};`,
    "",
  ].join("\n");
}

const ANSWERS_D_TS = `// Generated by infra/build/tool-api-validators.mjs (npm run build:validators): the types of ajv-answers.js.
// Git-ignored: never edit or commit (ADR-005).
import type { ErrorObject } from "ajv";

/** One check: a fixture (or {}) against one definition, and what Ajv's compiler answered in Node. */
export interface AjvCheck {
  /** The fixture's version, def and expectation in its contract's index; null for {}. */
  readonly version: string | null;
  readonly def: string | null;
  readonly expect: "accept" | "refuse" | null;
  /** The fixture's file, relative to contracts/; null for {}. */
  readonly source: string | null;
  /** The part of the fixture checked: an exchange's request or outcome, or null for the whole file. */
  readonly pick: "request" | "outcome" | null;
  /** The definition's $ref. */
  readonly definition: string;
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

export declare const ajvAnswers: {
  /** Each fixture checked, by its file relative to contracts/. */
  readonly fixtures: Readonly<Record<string, unknown>>;
  readonly checks: readonly AjvCheck[];
};
`;

function writeFile(file, text) {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** The value a check reads: the fixture's part, or {}. */
const valueOf = (answers, { source, pick }) => {
  const document = source === null ? {} : answers.fixtures[source];
  return pick === null ? document : document[pick];
};

/** Loads the written validators.js here in Node and lists every check whose answer differs from the compiler's. */
async function differences(outDir, answers) {
  const url = pathToFileURL(path.join(outDir, "validators.js"));
  url.searchParams.set("built", String(Date.now()));
  const { definitions } = await import(url.href);
  const differ = [];
  for (const entry of answers.checks) {
    const validate = definitions[entry.definition];
    const valid = validate(valueOf(answers, entry));
    const errors = valid ? [] : plain(validate.errors);
    if (valid !== entry.valid || !isDeepStrictEqual(errors, entry.errors)) {
      differ.push(`${entry.source ?? "{}"} ${entry.pick ?? ""} against ${entry.definition}`);
    }
  }
  return differ;
}

/** Builds everything into outDir; resolves to { definitions, checks, helpers, files }. */
export async function buildValidators({ contractsDir = CONTRACTS_DIR, outDir = DEFAULT_OUT } = {}) {
  const schemas = readSchemas(contractsDir);
  const definitions = definitionsOf(schemas);
  const generated = standaloneModule(schemas, definitions);
  const answers = ajvAnswers(schemas, definitions, contractsDir);
  mkdirSync(outDir, { recursive: true });
  const files = {
    "validators.js": validatorsJs(schemas, definitions, generated),
    "validators.d.ts": VALIDATORS_D_TS,
    "ajv-answers.js": answersJs(answers),
    "ajv-answers.d.ts": ANSWERS_D_TS,
  };
  for (const [name, text] of Object.entries(files)) writeFile(path.join(outDir, name), text);
  const differ = await differences(outDir, answers);
  if (differ.length > 0) {
    for (const name of Object.keys(files)) rmSync(path.join(outDir, name), { force: true });
    const listed = differ.slice(0, 10).join("; ");
    throw new Error(
      `the standalone code differs from Ajv's compiler on ${String(differ.length)} check(s): ${listed}`,
    );
  }
  return {
    definitions: definitions.length,
    checks: answers.checks.length,
    helpers: generated.helpers,
    schemas: schemas.map(({ file }) => file),
    files: Object.keys(files),
  };
}

/** Runs the build; resolves to the exit code. */
export async function main(argv, { write = (line) => console.log(line) } = {}) {
  let outDir = DEFAULT_OUT;
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--out" && argv[k + 1] !== undefined) {
      outDir = path.resolve(argv[k + 1]);
      k += 1;
    } else {
      write(
        `FAIL unknown argument "${argv[k]}". Usage: node infra/build/tool-api-validators.mjs [--out <dir>]`,
      );
      return 1;
    }
  }
  try {
    const built = await buildValidators({ outDir });
    const where = path.relative(process.cwd(), outDir) || ".";
    write(
      `tool-api validators: ${String(built.definitions)} standalone validators from ${String(built.schemas.length)} ` +
        `schema files written to ${where} (${built.files.join(", ")}); the code gives Ajv's compiled answer to ` +
        `all ${String(built.checks)} checks; run-time helpers: ${built.helpers.join(", ") || "none"}`,
    );
    return 0;
  } catch (error) {
    write(`FAIL tool-api validators: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
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

if (runAsScript()) process.exitCode = await main(process.argv.slice(2));
