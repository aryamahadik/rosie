// The Tool API's one validator (T-290, T-1150; 02-contracts section 2 items 2 and 8; contracts/README.md convention 8):
// Ajv 8 with its 2020-12 class in strict mode, the setup of contracts/scripts/lib.mjs and the contract harness, holding
// the frozen schemas. The Tool API registers K-09 v1's 29 calls (calls.ts); every call's request is checked against K-09
// v1.5's definition of the same name, `$defs/<call>.request`, and its handler's answer against `$defs/<call>.response`
// or `$defs/<call>.errors`. v1.5 holds every v1 definition under its own name, the unchanged ones by $ref back to v1.4
// to v1, and accepts every v1 exchange (README "v1.5"; DL-340), so gateAndCommit's turn may carry the service and the
// chat id of the turn's last text (default 135) and buildFrontier's context may offer the sign-up door (K-02 v1.1). A
// span is checked against K-08 v1.1's `span`. The frontier's checks (frontier/assemble/check.ts) read K-02 v1.1's
// choice, openQuestion, stepCard and context through the same checks (definitionChecks).
//
// Two ways to run the same checks, one answer (T-1144; DL-327):
//   - In Node, Ajv's compiler: the schemas are read from contracts/ on disk, as the other packages read frozen schemas
//     (the contract harness, the AI layer's recorded double, the runtime's and the adapters' tests), and each definition
//     is compiled the first time it is checked.
//   - Inside the Worker (workerd), the prebuilt code: Ajv compiles a schema with new Function, which the Workers runtime
//     refuses, and the Worker has no contracts/ on disk. So `npm run build:validators` (infra/build/tool-api-validators.mjs)
//     compiles these same definitions ahead of time, with these options, into Ajv's standalone code in ./generated/
//     (git-ignored, built before the type check, the tests and any Worker bundle). Nothing is evaluated at run time.
// The build checks that the code gives the compiler's answer to every check on the contracts' fixtures, and
// validator.worker.test.ts and the frontier's check.worker.test.ts check it again inside workerd. Problem lines name a
// path and what the schema wants, never a value.
//
// composeInput alone is checked by K-09 v1.6's definitions (T-1174, T-1189; README "v1.6"; DL-355, DL-373), in Node
// and inside workerd alike: its answer is K-03 v1.1's composer input, whose facts may also be term facts, or one of its
// errors, fixedLineRow and masterLineMissing among them. v1.6 accepts every v1 to v1.5 composeInput exchange, and its
// request is v1.5's by reference. SCHEMA_FILES holds v1.6 and K-03 v1.1 beside v1.5's files, and build:validators
// compiles composeInput's request, response and errors from v1.6 (its other calls' from v1.5), so the prebuilt code
// holds exactly the definitions toolApiSchemaIdOf names.
//
// A lane's calls (T-1022, DL-728; tool-api.ts Lane) are checked apart from these: laneChecks gives one call's request,
// response and errors by `$defs/<call>.<part>` of the frozen K-09 version its lane names, a version whose root carries
// the call by $ref (`$defs/<call>.exchange` in its anyOf), each read by the call's own name, never by a generated
// numbered one (DL-350). In Node they come from contracts/ on disk: the files that version's $refs reach, read the first
// time a lane names it, in an Ajv instance of their own with the same options, so SCHEMA_FILES and the prebuilt code
// stay exactly v1's. Inside workerd the prebuilt code holds no lane's definitions yet, so laneChecks refuses there and
// no lane is registered (fail closed) until infra/build/tool-api-validators.mjs builds them too.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { CALL_NAMES, type CallName } from "./calls";
import { build as prebuilt, definitions as prebuiltDefinitions } from "./generated/validators";

/** The $id of K-09 v1.5, whose definitions of K-09 v1's calls the validator checks (contracts/README.md convention 2). */
export const TOOL_API_SCHEMA_ID = "https://rosie.invalid/contracts/tool-api/tool-api.v1.5.schema.json";
/** The $id of K-09 v1.6, whose composeInput the validator checks in Node and in workerd (T-1174, T-1189). */
export const COMPOSE_INPUT_TOOL_API_SCHEMA_ID =
  "https://rosie.invalid/contracts/tool-api/tool-api.v1.6.schema.json";
/** The $id of K-08 v1.1, whose `span` is v1's, unchanged (event-trace README "v1.1"). */
export const EVENT_TRACE_SCHEMA_ID =
  "https://rosie.invalid/contracts/event-trace/event-trace.v1.1.schema.json";
/**
 * The $id of K-02 v1.1, whose choice, openQuestion, stepCard and context the frontier checks (frontier/assemble/check.ts):
 * the context K-09 v1.5's buildFrontier answers, whose doors also take signUp (K-02 README "v1.1").
 */
export const MODEL_SCHEMA_ID = "https://rosie.invalid/contracts/model/model.v1.1.schema.json";

/**
 * The frozen schema files the validator holds, relative to contracts/, in Node and in the prebuilt code alike: every file
 * K-09 v1.5's, K-09 v1.6's and K-08 v1.1's $refs reach, K-09 v1 to v1.4, K-02 v1 and v1.1, K-06 v1 (gateAndCommit.turn's
 * service) and K-03 v1.1 (whose composeInput v1.6's composeInput answers) among them (a test checks that the list is
 * exactly that closure).
 */
export const SCHEMA_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
  "model/model.v1.1.schema.json",
  "message-plan/message-plan.v1.schema.json",
  "message-plan/message-plan.v1.1.schema.json",
  "data-access/data-access.v1.schema.json",
  "inbound-event/inbound-event.v1.schema.json",
  "outbox-effects/outbox-effects.v1.schema.json",
  "event-trace/event-trace.v1.schema.json",
  "event-trace/event-trace.v1.1.schema.json",
  "tool-api/tool-api.v1.schema.json",
  "tool-api/tool-api.v1.1.schema.json",
  "tool-api/tool-api.v1.2.schema.json",
  "tool-api/tool-api.v1.3.schema.json",
  "tool-api/tool-api.v1.4.schema.json",
  "tool-api/tool-api.v1.5.schema.json",
  "tool-api/tool-api.v1.6.schema.json",
] as const;

/**
 * The two files of SCHEMA_FILES that K-09 v1.6's composeInput added (T-1174): K-03 v1.1 and v1.6 itself. Since T-1189
 * no list of its own: the validator and the prebuilt code read SCHEMA_FILES alone. The name stays only because
 * index.ts re-exports it (outside T-1189's card); it can go with that line.
 */
export const V1_6_SCHEMA_FILES = [
  "message-plan/message-plan.v1.1.schema.json",
  "tool-api/tool-api.v1.6.schema.json",
] as const satisfies readonly (typeof SCHEMA_FILES)[number][];

/** Ajv's options, for the compiler here and for the prebuilt code (infra/build/tool-api-validators.mjs). */
export const AJV_OPTIONS = { strict: true, strictRequired: false, allErrors: true } as const;

/** True inside the Workers runtime (workerd), whose navigator names it; Node's names Node.js. */
export const RUNS_IN_WORKERD = navigator.userAgent === "Cloudflare-Workers";

/**
 * The repository's contracts/ folder: this file is actions/src/tool-api/validator.ts. Empty inside workerd, which has no
 * contracts/ on disk (its checks are the prebuilt code).
 */
export const CONTRACTS_DIR = RUNS_IN_WORKERD
  ? ""
  : fileURLToPath(new URL("../../../contracts/", import.meta.url));

/** At most this many problem lines come back; one more line says how many were left out. */
const MAX_PROBLEMS = 20;

/** The three definitions every call has under `$defs` (02-contracts section 2 item 2). */
export type CallPart = "request" | "response" | "errors";

/** The parts every call has, in the order of 02-contracts section 2 item 2. */
const CALL_PARTS: readonly CallPart[] = ["request", "response", "errors"];

/** A K-09 version a lane may name: v1, or a minor version v1.<n> (contracts/README.md convention 1). */
const TOOL_API_VERSION = /^v1(?:\.[1-9][0-9]*)?$/u;

/** K-09's frozen versions, relative to contracts/: `{"frozen": [...]}`, oldest first, only ever added (contracts/README.md). */
const TOOL_API_FROZEN_FILE = "tool-api/frozen.json";

/** The schema file of K-09 version `version`, relative to contracts/ (contracts/README.md convention 1). */
function toolApiVersionFile(version: string): string {
  return `tool-api/tool-api.${version}.schema.json`;
}

/** The $id of K-09 version `version` (contracts/README.md convention 2), as a lane names it (tool-api.ts Lane). */
export function toolApiVersionSchemaId(version: string): string {
  return `https://rosie.invalid/contracts/${toolApiVersionFile(version)}`;
}

/**
 * One lane call's checks (T-1022, DL-728): its request, response and errors by `$defs/<call>.<part>` of the frozen K-09
 * version its lane names, read by the call's own name (DL-350).
 */
export interface LaneChecks {
  /** The K-09 version whose definitions check the call, as its lane names it (such as "v1.8"). */
  readonly version: string;
  readonly call: string;
  /** The problems `$defs/<call>.<part>` of that version finds in `value`, one line each; empty when accepted. */
  check(part: CallPart, value: unknown): string[];
}

export interface ToolApiValidator {
  /**
   * The problems `$defs/<call>.<part>` finds in `value`, one line each; empty when accepted: K-09 v1.5's, or v1.6's for
   * composeInput (toolApiSchemaIdOf).
   */
  check(call: CallName, part: CallPart, value: unknown): string[];
  /** The problems K-08 v1.1's `span` finds in `value`, one line each; empty when accepted. */
  checkSpan(value: unknown): string[];
  /**
   * A lane call's checks (T-1022, DL-728; tool-api.ts Lane): `$defs/<call>.request`, `.response` and `.errors` of K-09
   * `version`. Throws, so its lane is refused at registration, for a call of K-09 v1 (`check` holds those), a version that
   * is not frozen (contracts/tool-api/frozen.json), one whose root does not carry the call by $ref or that lacks one of
   * its three definitions, and inside workerd, whose prebuilt code holds no lane's definitions yet.
   */
  laneChecks(version: string, call: string): LaneChecks;
}

/** One definition's check, compiled or prebuilt: true when the value passes; when not, its errors are on `errors`. */
export interface Validate {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

/**
 * The checks of the frozen definitions, by a schema's $id and a definition's name; a definition the checks do not hold
 * throws.
 */
export type DefinitionChecks = (schemaId: string, definition: string) => Validate;

/** Reads the frozen schema files, SCHEMA_FILES, from `contractsDir` (default: this repository's contracts/); Node only. */
export function loadToolApiSchemas(contractsDir: string = CONTRACTS_DIR): object[] {
  if (RUNS_IN_WORKERD) {
    throw new Error(
      "workerd has no contracts/ on disk: createToolApiValidator() uses the prebuilt validators there",
    );
  }
  return SCHEMA_FILES.map(
    (file) => JSON.parse(readFileSync(path.join(contractsDir, ...file.split("/")), "utf8")) as object,
  );
}

/**
 * The $id of the K-09 version whose definitions check a call, in Node and in workerd alike: v1.6's for composeInput
 * (T-1174, T-1189), v1.5's for every other call.
 */
export function toolApiSchemaIdOf(call: CallName): string {
  return call === "composeInput" ? COMPOSE_INPUT_TOOL_API_SCHEMA_ID : TOOL_API_SCHEMA_ID;
}

/** Ajv's errors as one line each: the place (the root as "(root)") and what the schema wants. */
export function formatProblems(errors: readonly ErrorObject[] | null | undefined): string[] {
  const lines = (errors ?? []).map((error) => {
    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    let extra = "";
    if (error.keyword === "additionalProperties") {
      extra = ` (${String(error.params.additionalProperty)})`;
    } else if (error.keyword === "enum") {
      extra = ` (${(error.params.allowedValues as unknown[]).map(String).join(", ")})`;
    }
    return `${where} ${error.message ?? "is invalid"}${extra}`;
  });
  if (lines.length <= MAX_PROBLEMS) return lines;
  return [...lines.slice(0, MAX_PROBLEMS), `and ${String(lines.length - MAX_PROBLEMS)} more`];
}

/** `$defs/<definition>` of the schema whose $id is `schemaId`, as a $ref. */
const refOf = (schemaId: string, definition: string): string => `${schemaId}#/$defs/${definition}`;

/** One strict Ajv 2020-12 instance holding `schemas`: each definition compiled the first time it is checked, and kept. */
function compiledValidators(schemas: readonly object[]): DefinitionChecks {
  const ajv = new Ajv2020(AJV_OPTIONS);
  for (const schema of schemas) ajv.addSchema(schema);
  return (schemaId, definition) => {
    const validate = ajv.getSchema(refOf(schemaId, definition));
    if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
    return validate;
  };
}

/** Whether two lists hold the same strings, in any order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The prebuilt code (./generated/validators.js), once it is shown to hold exactly these schemas with these options, each
 * call's definitions of the K-09 version toolApiSchemaIdOf names: code built for other schemas, versions or options
 * throws rather than check against the wrong contract.
 */
function prebuiltValidators(): DefinitionChecks {
  const options = Object.entries(AJV_OPTIONS);
  const v16Calls = CALL_NAMES.filter((call) => toolApiSchemaIdOf(call) === COMPOSE_INPUT_TOOL_API_SCHEMA_ID);
  const stale =
    prebuilt.toolApiSchemaId !== TOOL_API_SCHEMA_ID ||
    prebuilt.composeInputToolApiSchemaId !== COMPOSE_INPUT_TOOL_API_SCHEMA_ID ||
    !sameList(prebuilt.composeInputToolApiCalls, v16Calls) ||
    prebuilt.eventTraceSchemaId !== EVENT_TRACE_SCHEMA_ID ||
    prebuilt.modelSchemaId !== MODEL_SCHEMA_ID ||
    !sameList(prebuilt.schemaFiles, SCHEMA_FILES) ||
    Object.keys(prebuilt.options).length !== options.length ||
    options.some(([name, value]) => prebuilt.options[name] !== value);
  if (stale) {
    throw new Error(
      "the prebuilt validators hold other schemas or options than validator.ts: run npm run build:validators " +
        "(after changing validator.ts's contracts or options, infra/build/tool-api-validators.mjs's first)",
    );
  }
  return (schemaId, definition) => {
    const validate = prebuiltDefinitions[refOf(schemaId, definition)];
    if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
    return validate;
  };
}

/**
 * The checks the Tool API's validator and the frontier's checker run on. In Node: one strict Ajv 2020-12 instance
 * holding `schemas` (default: the frozen files from disk). Inside workerd: the prebuilt code, which holds the frozen
 * files as the build read them; workerd cannot compile, so passing `schemas` there throws.
 */
export function definitionChecks(schemas?: readonly object[]): DefinitionChecks {
  if (!RUNS_IN_WORKERD) return compiledValidators(schemas ?? loadToolApiSchemas());
  if (schemas !== undefined) {
    throw new Error(
      "Ajv's compiler cannot run inside workerd (new Function): the prebuilt validators check there, so pass no schemas",
    );
  }
  return prebuiltValidators();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every file a schema's $refs name, relative to contracts/ (a $ref inside the schema itself names none). */
function referencedFiles(file: string, schema: object): string[] {
  const files: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (isRecord(value)) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref" && typeof inner === "string") {
          const target = inner.split("#")[0] ?? "";
          if (target !== "") files.push(path.posix.join(path.posix.dirname(file), target));
        } else {
          walk(inner);
        }
      }
    }
  };
  walk(schema);
  return files;
}

/**
 * The lane calls' checks, in Node (T-1022, DL-728): one strict Ajv 2020-12 instance with AJV_OPTIONS holding, for each
 * K-09 version a lane names, every file that version's $refs reach, read from `contractsDir` the first time the version
 * is named. A call's three definitions are compiled when its lane names it, so a definition that does not compile
 * refuses the lane at registration, and they are kept.
 */
function laneDefinitionChecks(contractsDir: string): (version: string, call: string) => LaneChecks {
  const ajv = new Ajv2020(AJV_OPTIONS);
  /** Every file the instance holds, relative to contracts/, as read. */
  const held = new Map<string, Record<string, unknown>>();
  let frozen: readonly string[] | undefined;

  const read = (file: string): Record<string, unknown> => {
    const schema = JSON.parse(readFileSync(path.join(contractsDir, ...file.split("/")), "utf8")) as unknown;
    if (!isRecord(schema)) throw new Error(`${file} is not a JSON object`);
    return schema;
  };
  /** Adds `root` and every file its $refs reach that the instance does not hold yet; gives `root` as read. */
  const hold = (root: string): Record<string, unknown> | undefined => {
    const queue = [root];
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (held.has(file)) continue;
      const schema = read(file);
      ajv.addSchema(schema);
      held.set(file, schema);
      queue.push(...referencedFiles(file, schema));
    }
    return held.get(root);
  };
  /** K-09's frozen versions, read once (contracts/tool-api/frozen.json). */
  const frozenVersions = (): readonly string[] => {
    if (frozen === undefined) {
      const list = read(TOOL_API_FROZEN_FILE).frozen;
      frozen = Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    }
    return frozen;
  };

  return (version, call) => {
    if ((CALL_NAMES as readonly string[]).includes(call)) {
      throw new Error(`${call} is a call of K-09 v1: check() holds it, never a lane`);
    }
    // Checked before any file is read, so a version can name nothing but a K-09 schema file.
    if (!TOOL_API_VERSION.test(version)) throw new Error("not a K-09 version (v1 or v1.<n>)");
    if (!frozenVersions().includes(version)) throw new Error(`K-09 ${version} is not frozen`);
    const schemaId = toolApiVersionSchemaId(version);
    const root = hold(toolApiVersionFile(version));
    if (root?.$id !== schemaId) throw new Error(`the file of K-09 ${version} has another $id`);
    const carried =
      Array.isArray(root.anyOf) &&
      root.anyOf.some((branch) => isRecord(branch) && branch.$ref === `#/$defs/${call}.exchange`);
    if (!carried) throw new Error(`K-09 ${version}'s root does not carry ${call} by $ref`);
    const defs = isRecord(root.$defs) ? root.$defs : {};
    const validators = new Map<CallPart, Validate>();
    for (const part of CALL_PARTS) {
      const definition = `${call}.${part}`;
      const validate = Object.hasOwn(defs, definition)
        ? ajv.getSchema(refOf(schemaId, definition))
        : undefined;
      if (validate === undefined) throw new Error(`K-09 ${version} has no ${definition}`);
      validators.set(part, validate);
    }
    return {
      version,
      call,
      check(part, value) {
        const validate = validators.get(part);
        if (validate === undefined) throw new Error(`a call has no part ${part}`);
        return validate(value) ? [] : formatProblems(validate.errors);
      },
    };
  };
}

/**
 * The one validator, over definitionChecks(schemas). Either way, a definition the validator does not hold throws, since
 * the call list and the contract must never drift apart; a name that is no call of K-09 v1 throws before any check. A
 * lane's calls are checked by laneChecks, whose definitions are always the frozen files on disk, read when a lane first
 * names its version (laneDefinitionChecks); inside workerd it refuses every lane.
 */
export function createToolApiValidator(schemas?: readonly object[]): ToolApiValidator {
  if (RUNS_IN_WORKERD && schemas !== undefined) {
    throw new Error(
      "Ajv's compiler cannot run inside workerd (new Function): call createToolApiValidator() there",
    );
  }
  const validatorOf = definitionChecks(schemas);
  const problemsOf = (validate: Validate, value: unknown): string[] =>
    validate(value) ? [] : formatProblems(validate.errors);
  let laneChecksOf: ((version: string, call: string) => LaneChecks) | undefined;

  return {
    check(call, part, value) {
      if (!(CALL_NAMES as readonly string[]).includes(call)) throw new Error("not a call of K-09 v1");
      return problemsOf(validatorOf(toolApiSchemaIdOf(call), `${call}.${part}`), value);
    },
    checkSpan(value) {
      return problemsOf(validatorOf(EVENT_TRACE_SCHEMA_ID, "span"), value);
    },
    laneChecks(version, call) {
      if (RUNS_IN_WORKERD) {
        throw new Error(
          "the prebuilt validators hold no lane's definitions: no lane is registered inside workerd until " +
            "infra/build/tool-api-validators.mjs builds them",
        );
      }
      laneChecksOf ??= laneDefinitionChecks(CONTRACTS_DIR);
      return laneChecksOf(version, call);
    },
  };
}
