#!/usr/bin/env node
// The Tool API's, the frontier's and compose input's schema checks, compiled ahead of time for the Worker (T-1144,
// T-1150, T-1165; DL-327, DL-340, DL-357; ADR-005): `npm run build:validators`. ES module, so strict mode is on.
//
// Ajv compiles a schema with new Function, which the Workers runtime refuses (actions/README.md, open point "Ajv in
// the Worker"). So this build compiles, here in Node, exactly the definitions actions/src/tool-api/validator.ts and
// actions/src/frontier/assemble/check.ts check: for each call of K-09 v1's `$defs/callName` (the 29 calls the Tool API
// registers; the calls v1.1 to v1.4 add are their journey lanes'), K-09 v1.5's `$defs/<call>.request`, `.response` and
// `.errors` (v1.5 holds every v1 definition under its own name, the unchanged ones by $ref back to v1.4 to v1, and
// accepts every v1 exchange: README "v1.5"); K-08 v1.1's `$defs/span`; and K-02 v1.1's `$defs/choice`,
// `openQuestion`, `stepCard` and `context`, the frontier's checks. It reads every schema their $refs reach from
// contracts/ on disk (nothing is fetched), and uses validator.ts's Ajv: the 2020-12 class in strict mode with the same
// options, so the code is the code Ajv's compiler runs in Node. Ajv writes it out as standalone code
// (ajv/dist/standalone): plain JavaScript that needs no compiler, so nothing is evaluated at run time. The run-time
// helpers it calls (ajv/dist/runtime) are imported, and the bundler takes them from node_modules, so ajv stays a
// devDependency.
//
// Compose input's check (actions/src/compose-input/check.ts) gets a module of its own, built the same way, with the same
// options: K-03 v1's and v1.1's `$defs/composeInput`, from the schemas their $refs reach. v1's is the input compose
// input checks today; v1.1's, whose facts may also be term facts, is the one T-1174 moves it to (DL-355, DL-357), so
// that move needs no change here. A module of its own, because validators.js holds exactly the definitions validator.ts
// and the frontier's checks read, built from exactly the files K-09 v1.5's and K-08 v1.1's $refs reach
// (validator.worker.test.ts holds it to that), and K-03 v1.1 is none of those files.
//
// It writes into actions/src/tool-api/generated/, which is git-ignored, never edited and never committed (ADR-005):
//   validators.js     the standalone code: one validate function per definition, `definitions` (each by its $ref)
//                     and `build` (Ajv's version, the options, the schema ids and files, each file's sha256);
//   validators.d.ts   its types;
//   ajv-answers.js    what Ajv's compiler itself answers here in Node, with validator.ts's options, to each check on
//                     the contracts' own fixtures (each K-09 fixture of a K-09 v1 call, every version, with the K-02
//                     context a buildFrontier exchange answers; each K-08 span fixture; each K-02 fixture of a
//                     definition the frontier checks; each choice, open question and card of those contexts) and on
//                     {} for each definition. validator.worker.test.ts and check.worker.test.ts hold the code to
//                     these answers inside workerd, where the compiler cannot run;
//   ajv-answers.d.ts  its types;
//   compose-input-validators.js, compose-input-validators.d.ts, compose-input-answers.js, compose-input-answers.d.ts
//                     the same four for compose input's check: the standalone code of K-03 v1's and v1.1's
//                     composeInput, with its `definitions` and its `build` (the K-03 ids in place of the three above);
//                     and what Ajv's compiler answers to each K-03 input on the contracts' fixtures (each K-03
//                     composeInput fixture, each inputAndPlan fixture's input, and the input each K-09 composeInput
//                     exchange answers), each under both versions, and to {} for each, which
//                     actions/src/compose-input/check.worker.test.ts holds the code to inside workerd.
// It writes them first into a staging folder of its own inside that folder, loads validators.js and
// compose-input-validators.js from there in this Node and checks that each gives every one of its answers; only then
// does it move the eight files into place. On any failure (a check that differs, or one that throws) it removes the
// staging folder and the eight files in place, and fails, so no unchecked code and no code that differs from the
// compiler's is ever left in place (the security reviewer's note 1 on T-1144).
//
// It runs before lint, the type check, the tests and the staging deploy: `npm run contracts:types` runs it after the
// contract types (the step ci.yml and merge-check.yml, and so the local merge-check, run before lint and the type
// check), and `npm test`, `npm run test:<project>`, `npm run test:count` and `npm run deploy:staging` run it first
// (their pre scripts in package.json), so no test and no staging bundle runs stale or missing code.
//
// Usage: node infra/build/tool-api-validators.mjs [--out <dir>]
// Exit code: 0 written, 1 failed.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** K-09 v1, whose `$defs/callName` lists the calls the Tool API registers (actions/src/tool-api/calls.ts). */
export const CALLS_FILE = "tool-api/tool-api.v1.schema.json";
/** K-09 v1.5, whose definitions of those calls validator.ts checks, relative to contracts/. */
export const TOOL_API_FILE = "tool-api/tool-api.v1.5.schema.json";
/** K-08 v1.1, whose `span` validator.ts checks. */
export const EVENT_TRACE_FILE = "event-trace/event-trace.v1.1.schema.json";
/** K-02 v1.1, whose definitions the frontier checks (actions/src/frontier/assemble/check.ts). */
export const MODEL_FILE = "model/model.v1.1.schema.json";

/** The three definitions of every call under $defs (02-contracts section 2 item 2): validator.ts's CallPart. */
export const PARTS = Object.freeze(["request", "response", "errors"]);

/** The K-02 v1.1 definitions the frontier checks: check.ts's K02_PARTS. */
export const MODEL_PARTS = Object.freeze(["choice", "openQuestion", "stepCard", "context"]);

/**
 * K-03 v1 and v1.1, relative to contracts/, whose `composeInput` compose input checks (actions/src/compose-input/check.ts:
 * its COMPOSE_INPUT_SCHEMA_IDS, in this order): v1's today, v1.1's once T-1174 moves compose input to it.
 */
export const MESSAGE_PLAN_FILES = Object.freeze([
  "message-plan/message-plan.v1.schema.json",
  "message-plan/message-plan.v1.1.schema.json",
]);

/** The K-03 definition compose input checks. */
export const COMPOSE_INPUT_DEFINITION = "composeInput";

/** The fixture indexes the answers are taken on, relative to contracts/. */
const TOOL_API_INDEX = "tool-api/fixtures/index.json";
const EVENT_TRACE_INDEX = "event-trace/fixtures/index.json";
const MODEL_INDEX = "model/fixtures/index.json";
const MESSAGE_PLAN_INDEX = "message-plan/fixtures/index.json";

/** The K-03 fixtures that hold a composer input, by their definition, with the input's place in the file. */
const INPUT_PLACES = Object.freeze({ composeInput: [], inputAndPlan: ["input"] });

/** The lists of a K-02 context the frontier checks item by item, with the definition of each item. */
const CONTEXT_LISTS = Object.freeze([
  ["choices", "choice"],
  ["openQuestions", "openQuestion"],
  ["cards", "stepCard"],
]);

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

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

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

/**
 * K-09 v1.5, K-08 v1.1 and every schema file their $refs reach (K-09 v1, whose call list the Tool API keeps, and K-02
 * v1.1, the frontier's, among them), each with its text's sha256, sorted by file. Given other `roots` (compose input's
 * MESSAGE_PLAN_FILES), those files and every file their $refs reach instead.
 */
export function readSchemas(contractsDir = CONTRACTS_DIR, roots = [TOOL_API_FILE, EVENT_TRACE_FILE]) {
  const read = new Map();
  const queue = [...roots];
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

/** One schema the build read, by its file; throws when the files read do not hold it. */
function schemaOf(schemas, file) {
  const schema = schemas.find((entry) => entry.file === file)?.schema;
  if (schema === undefined) throw new Error(`${file} is not among the schema files the build read`);
  return schema;
}

/** The calls the Tool API registers: K-09 v1's `$defs/callName`, in its order. */
function callNamesOf(schemas) {
  const calls = schemaOf(schemas, CALLS_FILE).$defs?.callName?.enum;
  if (!Array.isArray(calls) || calls.length === 0)
    throw new Error(`${CALLS_FILE} has no $defs/callName list`);
  return calls;
}

/**
 * Each definition the code holds, as { exportName, ref }: K-09 v1.5's for each call of K-09 v1, in callName's order,
 * then K-08 v1.1's span, then K-02 v1.1's four, in MODEL_PARTS' order.
 */
export function definitionsOf(schemas) {
  const toolApi = schemaOf(schemas, TOOL_API_FILE);
  const eventTrace = schemaOf(schemas, EVENT_TRACE_FILE);
  const model = schemaOf(schemas, MODEL_FILE);
  const definitions = [];
  for (const call of callNamesOf(schemas)) {
    for (const part of PARTS) {
      const name = `${call}.${part}`;
      if (toolApi.$defs?.[name] === undefined) throw new Error(`${TOOL_API_FILE} has no definition ${name}`);
      definitions.push({ exportName: `${call}_${part}`, ref: `${toolApi.$id}#/$defs/${name}` });
    }
  }
  if (eventTrace.$defs?.span === undefined) throw new Error(`${EVENT_TRACE_FILE} has no definition span`);
  definitions.push({ exportName: "span", ref: `${eventTrace.$id}#/$defs/span` });
  for (const part of MODEL_PARTS) {
    if (model.$defs?.[part] === undefined) throw new Error(`${MODEL_FILE} has no definition ${part}`);
    definitions.push({ exportName: `k02_${part}`, ref: `${model.$id}#/$defs/${part}` });
  }
  for (const { exportName } of definitions) {
    if (!IDENTIFIER.test(exportName)) throw new Error(`${exportName} cannot be an export name`);
  }
  return definitions;
}

/**
 * Each definition compose input's code holds, as { exportName, ref }: `composeInput` of each of MESSAGE_PLAN_FILES, in
 * its order (K-03 v1's, then v1.1's), from the schemas readSchemas(contractsDir, MESSAGE_PLAN_FILES) read.
 */
export function composeInputDefinitionsOf(schemas) {
  return MESSAGE_PLAN_FILES.map((file) => {
    const schema = schemaOf(schemas, file);
    if (schema.$defs?.[COMPOSE_INPUT_DEFINITION] === undefined) {
      throw new Error(`${file} has no definition ${COMPOSE_INPUT_DEFINITION}`);
    }
    // message-plan.v1.1.schema.json gives message_plan_v1_1_composeInput.
    const version = path.posix.basename(file, ".schema.json").replace(/[^A-Za-z0-9]/g, "_");
    const exportName = `${version}_${COMPOSE_INPUT_DEFINITION}`;
    if (!IDENTIFIER.test(exportName)) throw new Error(`${exportName} cannot be an export name`);
    return { exportName, ref: `${schema.$id}#/$defs/${COMPOSE_INPUT_DEFINITION}` };
  });
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

/** The value at `at`, a path of keys and indexes from a document's root; undefined when there is none. */
function valueAt(document, at) {
  let value = document;
  for (const key of at) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

/**
 * Where Ajv's compiler's answers go, for the checks of `definitions` (each { ref }) on the Ajv instance `ajv`: the
 * fixtures read, by source, and the checks. `check(about, source, at, ref)` checks the value at `at` in the fixture
 * `source` (read into `fixtures` first; null for {}) against `ref`, and records the answer.
 */
function answerRecord(ajv, definitions) {
  const refs = new Set(definitions.map(({ ref }) => ref));
  const fixtures = {};
  const checks = [];
  const check = (about, source, at, ref) => {
    const validate = ajv.getSchema(ref);
    if (validate === undefined || !refs.has(ref)) throw new Error(`no definition ${ref}`);
    const value = valueAt(source === null ? {} : fixtures[source], at);
    if (value === undefined) throw new Error(`${String(source)} holds nothing at /${at.join("/")}`);
    const valid = validate(value);
    checks.push({
      ...about,
      source,
      at,
      definition: ref,
      valid,
      errors: valid ? [] : plain(validate.errors),
    });
  };
  return { fixtures, checks, check };
}

/**
 * What Ajv's compiler answers in Node, with validator.ts's options: each check as { version, def, expect, source, at,
 * definition, valid, errors }, and the fixtures it reads by source (a file relative to contracts/). `at` is the path
 * of keys from the fixture's root to the value checked: ["request"] or ["outcome"] of an exchange, a K-02 context's
 * place and its items' (["outcome", "context", "choices", 0]), or [] for the whole file; a source of null is {}.
 */
export function ajvAnswers(schemas, definitions, contractsDir = CONTRACTS_DIR) {
  const ajv = ajvWith(schemas, AJV_OPTIONS);
  const toolApi = schemaOf(schemas, TOOL_API_FILE);
  const eventTrace = schemaOf(schemas, EVENT_TRACE_FILE);
  const model = schemaOf(schemas, MODEL_FILE);
  const calls = new Set(callNamesOf(schemas));
  const { fixtures, checks, check } = answerRecord(ajv, definitions);

  const toolApiRef = (name) => `${toolApi.$id}#/$defs/${name}`;
  const modelRef = (part) => `${model.$id}#/$defs/${part}`;
  /** A K-02 context against the frontier's `context`, and each of its choices, open questions and cards. */
  const checkContext = (about, source, at) => {
    check(about, source, at, modelRef("context"));
    const context = valueAt(fixtures[source], at);
    for (const [list, part] of CONTEXT_LISTS) {
      const items = isRecord(context) ? context[list] : undefined;
      if (!Array.isArray(items)) continue;
      for (let index = 0; index < items.length; index += 1) {
        check(about, source, [...at, list, index], modelRef(part));
      }
    }
  };

  for (const entry of readJson(contractsDir, TOOL_API_INDEX).fixtures) {
    const [call, part] = entry.def.split(".");
    if (!calls.has(call) || !(part === "exchange" || PARTS.includes(part))) continue;
    const source = `tool-api/fixtures/${entry.file}`;
    fixtures[source] = readJson(contractsDir, source);
    const about = { version: entry.version, def: entry.def, expect: entry.expect };
    if (part === "exchange") {
      check(about, source, ["request"], toolApiRef(`${call}.request`));
      check(about, source, ["outcome"], toolApiRef(`${call}.response`));
      check(about, source, ["outcome"], toolApiRef(`${call}.errors`));
      // The frontier a buildFrontier exchange answers, as the frontier's checks read it before it goes (K-02 v1.1).
      if (call === "buildFrontier" && isRecord(fixtures[source].outcome?.context)) {
        checkContext(about, source, ["outcome", "context"]);
      }
    } else {
      check(about, source, [], toolApiRef(entry.def));
    }
  }
  const spanRef = `${eventTrace.$id}#/$defs/span`;
  for (const entry of readJson(contractsDir, EVENT_TRACE_INDEX).fixtures) {
    if (entry.def !== "span") continue;
    const source = `event-trace/fixtures/${entry.file}`;
    fixtures[source] = readJson(contractsDir, source);
    check({ version: entry.version, def: entry.def, expect: entry.expect }, source, [], spanRef);
  }
  for (const entry of readJson(contractsDir, MODEL_INDEX).fixtures) {
    if (!MODEL_PARTS.includes(entry.def)) continue;
    const source = `model/fixtures/${entry.file}`;
    fixtures[source] = readJson(contractsDir, source);
    const about = { version: entry.version, def: entry.def, expect: entry.expect };
    if (entry.def === "context") checkContext(about, source, []);
    else check(about, source, [], modelRef(entry.def));
  }
  for (const { ref } of definitions) check({ version: null, def: null, expect: null }, null, [], ref);
  return { fixtures, checks };
}

/**
 * What Ajv's compiler answers in Node, with the same options, to compose input's checks, in ajvAnswers' form: each K-03
 * input on the contracts' fixtures under each version's composeInput (`definitions`: composeInputDefinitionsOf's).
 * The inputs are each K-03 composeInput fixture (at []), each K-03 inputAndPlan fixture's input (["input"]), and the
 * input each K-09 composeInput exchange answers (["outcome", "input"]: compose-input-s1-02.json's is K-03's
 * input-s1-02.json); then {} against each.
 */
export function composeInputAnswers(schemas, definitions, contractsDir = CONTRACTS_DIR) {
  const ajv = ajvWith(schemas, AJV_OPTIONS);
  const { fixtures, checks, check } = answerRecord(ajv, definitions);
  const checkInput = (about, source, at) => {
    for (const { ref } of definitions) check(about, source, at, ref);
  };
  for (const entry of readJson(contractsDir, MESSAGE_PLAN_INDEX).fixtures) {
    const at = INPUT_PLACES[entry.def];
    if (at === undefined) continue;
    const source = `message-plan/fixtures/${entry.file}`;
    fixtures[source] = readJson(contractsDir, source);
    checkInput({ version: entry.version, def: entry.def, expect: entry.expect }, source, at);
  }
  for (const entry of readJson(contractsDir, TOOL_API_INDEX).fixtures) {
    if (entry.def !== `${COMPOSE_INPUT_DEFINITION}.exchange`) continue;
    const source = `tool-api/fixtures/${entry.file}`;
    const exchange = readJson(contractsDir, source);
    if (!isRecord(exchange.outcome?.input)) continue;
    fixtures[source] = exchange;
    checkInput({ version: entry.version, def: entry.def, expect: entry.expect }, source, [
      "outcome",
      "input",
    ]);
  }
  for (const { ref } of definitions) check({ version: null, def: null, expect: null }, null, [], ref);
  return { fixtures, checks };
}

const json = (value) => JSON.stringify(value, null, 2);

/** The version of Ajv that compiles the code. */
const ajvVersion = () =>
  JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("ajv/package.json")), "utf8")).version;

function validatorsJs(schemas, definitions, generated) {
  const build = {
    ajv: ajvVersion(),
    options: AJV_OPTIONS,
    toolApiSchemaId: schemaOf(schemas, TOOL_API_FILE).$id,
    eventTraceSchemaId: schemaOf(schemas, EVENT_TRACE_FILE).$id,
    modelSchemaId: schemaOf(schemas, MODEL_FILE).$id,
    schemaFiles: schemas.map(({ file }) => file),
    sha256: Object.fromEntries(schemas.map(({ file, sha256 }) => [file, sha256])),
    helpers: generated.helpers,
  };
  const header = [
    "// Generated by infra/build/tool-api-validators.mjs (npm run build:validators) from contracts/: Ajv's standalone",
    "// code for the definitions actions/src/tool-api/validator.ts and actions/src/frontier/assemble/check.ts check.",
    "// Git-ignored: never edit or commit (ADR-005).",
  ];
  return moduleJs(header, definitions, generated, build);
}

/** compose-input-validators.js: compose input's code, with the K-03 ids in place of validators.js's three. */
function composeInputValidatorsJs(schemas, definitions, generated) {
  const build = {
    ajv: ajvVersion(),
    options: AJV_OPTIONS,
    messagePlanSchemaIds: MESSAGE_PLAN_FILES.map((file) => schemaOf(schemas, file).$id),
    schemaFiles: schemas.map(({ file }) => file),
    sha256: Object.fromEntries(schemas.map(({ file, sha256 }) => [file, sha256])),
    helpers: generated.helpers,
  };
  const header = [
    "// Generated by infra/build/tool-api-validators.mjs (npm run build:validators) from contracts/: Ajv's standalone",
    "// code for the definitions actions/src/compose-input/check.ts checks, K-03 v1's and v1.1's composeInput.",
    "// Git-ignored: never edit or commit (ADR-005).",
  ];
  return moduleJs(header, definitions, generated, build);
}

/**
 * One module of standalone code: its header, the run-time helpers it imports (none when the code calls none), the code,
 * `definitions` and `build`.
 */
function moduleJs(header, definitions, generated, build) {
  const table = definitions
    .map(({ exportName, ref }) => `  ${JSON.stringify(ref)}: ${exportName},`)
    .join("\n");
  const helpers =
    generated.helpers.length === 0
      ? []
      : [
          ...generated.imports,
          "",
          "/** Ajv's run-time helper: a bundler gives the CommonJS module's default export, Node gives module.exports. */",
          'const helper = (module) => (typeof module === "function" ? module : module.default);',
          ...generated.picks,
        ];
  return [
    ...header,
    ...helpers,
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
  readonly modelSchemaId: string;
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

/** One check: a fixture's value (or {}) against one definition, and what Ajv's compiler answered in Node. */
export interface AjvCheck {
  /** The fixture's version, def and expectation in its contract's index; null for {}. */
  readonly version: string | null;
  readonly def: string | null;
  readonly expect: "accept" | "refuse" | null;
  /** The fixture's file, relative to contracts/; null for {}. */
  readonly source: string | null;
  /** The keys from the fixture's root to the value checked: an exchange's request or outcome, a K-02 context's place
   * or one of its items; empty for the whole file. */
  readonly at: readonly (string | number)[];
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

const COMPOSE_INPUT_VALIDATORS_D_TS = `// Generated by infra/build/tool-api-validators.mjs (npm run build:validators): the types of
// compose-input-validators.js. Git-ignored: never edit or commit (ADR-005).
import type { StandaloneValidate } from "./validators";

/** K-03 v1's and v1.1's composeInput validate functions, by $ref: the schema's $id, "#/$defs/" and "composeInput". */
export declare const definitions: Readonly<Record<string, StandaloneValidate>>;

/** What compose-input-validators.js was built from: the K-03 versions whose composeInput it holds, in order. */
export declare const build: {
  readonly ajv: string;
  readonly options: Readonly<Record<string, boolean>>;
  readonly messagePlanSchemaIds: readonly string[];
  readonly schemaFiles: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
  readonly helpers: readonly string[];
};
`;

const COMPOSE_INPUT_ANSWERS_D_TS = `// Generated by infra/build/tool-api-validators.mjs (npm run build:validators): the types of
// compose-input-answers.js. Git-ignored: never edit or commit (ADR-005).
import type { AjvCheck } from "./ajv-answers";

export type { AjvCheck };

/**
 * Compose input's checks: each K-03 input on the contracts' fixtures (a composeInput fixture's whole file, an
 * inputAndPlan fixture's input, a K-09 composeInput exchange's outcome.input) against K-03 v1's and v1.1's
 * composeInput, and {} against each, with what Ajv's compiler answered in Node.
 */
export declare const ajvAnswers: {
  /** Each fixture checked, by its file relative to contracts/. */
  readonly fixtures: Readonly<Record<string, unknown>>;
  readonly checks: readonly AjvCheck[];
};
`;

/** The value a check reads: the fixture's value at its path, or {}. */
const valueOf = (answers, { source, at }) => valueAt(source === null ? {} : answers.fixtures[source], at);

/** Loads the module `file` from `dir` here in Node and lists every check whose answer differs from the compiler's. */
async function differences(dir, file, answers) {
  const url = pathToFileURL(path.join(dir, file));
  url.searchParams.set("built", String(Date.now()));
  const { definitions } = await import(url.href);
  const differ = [];
  for (const entry of answers.checks) {
    const validate = definitions[entry.definition];
    const valid = validate(valueOf(answers, entry));
    const errors = valid ? [] : plain(validate.errors);
    if (valid !== entry.valid || !isDeepStrictEqual(errors, entry.errors)) {
      differ.push(`${entry.source ?? "{}"} /${entry.at.join("/")} against ${entry.definition}`);
    }
  }
  return differ;
}

/**
 * Builds everything into outDir; resolves to { definitions, checks, helpers, schemas, files, composeInput }, where
 * composeInput is { definitions, checks, helpers, schemas } for compose input's module. The files are written into a
 * staging folder inside outDir and moved into place only once each module gives every answer of the compiler; any
 * failure removes the staging folder and the files in place, then throws.
 */
export async function buildValidators({ contractsDir = CONTRACTS_DIR, outDir = DEFAULT_OUT } = {}) {
  const schemas = readSchemas(contractsDir);
  const definitions = definitionsOf(schemas);
  const generated = standaloneModule(schemas, definitions);
  const answers = ajvAnswers(schemas, definitions, contractsDir);
  // Compose input's module: K-03 v1's and v1.1's composeInput, from the files they reach.
  const k03Schemas = readSchemas(contractsDir, MESSAGE_PLAN_FILES);
  const k03Definitions = composeInputDefinitionsOf(k03Schemas);
  const k03Generated = standaloneModule(k03Schemas, k03Definitions);
  const k03Answers = composeInputAnswers(k03Schemas, k03Definitions, contractsDir);
  const files = {
    "validators.js": validatorsJs(schemas, definitions, generated),
    "validators.d.ts": VALIDATORS_D_TS,
    "ajv-answers.js": answersJs(answers),
    "ajv-answers.d.ts": ANSWERS_D_TS,
    "compose-input-validators.js": composeInputValidatorsJs(k03Schemas, k03Definitions, k03Generated),
    "compose-input-validators.d.ts": COMPOSE_INPUT_VALIDATORS_D_TS,
    "compose-input-answers.js": answersJs(k03Answers),
    "compose-input-answers.d.ts": COMPOSE_INPUT_ANSWERS_D_TS,
  };
  mkdirSync(outDir, { recursive: true });
  // Inside outDir, so the code resolves Ajv's run-time helpers from the same node_modules, each move is a rename on one
  // file system, and a staging folder a killed run leaves stays git-ignored, lint-ignored and out of the type check.
  const staging = mkdtempSync(path.join(outDir, ".build-"));
  let placed = false;
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(staging, name), text);
    const differ = [
      ...(await differences(staging, "validators.js", answers)),
      ...(await differences(staging, "compose-input-validators.js", k03Answers)),
    ];
    if (differ.length > 0) {
      const listed = differ.slice(0, 10).join("; ");
      throw new Error(
        `the standalone code differs from Ajv's compiler on ${String(differ.length)} check(s): ${listed}`,
      );
    }
    for (const name of Object.keys(files)) renameSync(path.join(staging, name), path.join(outDir, name));
    placed = true;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!placed) for (const name of Object.keys(files)) rmSync(path.join(outDir, name), { force: true });
  }
  return {
    definitions: definitions.length,
    checks: answers.checks.length,
    helpers: generated.helpers,
    schemas: schemas.map(({ file }) => file),
    files: Object.keys(files),
    composeInput: {
      definitions: k03Definitions.length,
      checks: k03Answers.checks.length,
      helpers: k03Generated.helpers,
      schemas: k03Schemas.map(({ file }) => file),
    },
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
    const k03 = built.composeInput;
    write(
      `tool-api validators: ${String(built.definitions)} standalone validators from ${String(built.schemas.length)} ` +
        `schema files written to ${where} (${built.files.join(", ")}); the code gives Ajv's compiled answer to ` +
        `all ${String(built.checks)} checks; run-time helpers: ${built.helpers.join(", ") || "none"}. ` +
        `Compose input's: ${String(k03.definitions)} standalone validators from ${String(k03.schemas.length)} ` +
        `schema files; the code gives Ajv's compiled answer to all ${String(k03.checks)} checks; run-time helpers: ` +
        `${k03.helpers.join(", ") || "none"}`,
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
