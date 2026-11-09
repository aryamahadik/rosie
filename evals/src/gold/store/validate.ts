// K-10 v1's check of one gold-set item, as the gold store runs it on every write and every read (T-470; C-139).
//
// One validator (contracts/README.md convention 8; 02-contracts section 2 item 8): Ajv 8 with its 2020-12 class in
// strict mode, set up as T-003's shared harness (tests/contract/_harness/fixtures.ts) and contracts/scripts/lib.mjs set
// it up, with each problem one line in the harness's formatErrors form (the lines contracts:check prints). The store
// does not import the harness: the harness imports Vitest at its top, which throws outside a Vitest run, and the store
// is also for the generators' own runs (T-471 to T-476). validate.test.ts checks this file against the harness on every
// K-10 item fixture: the same verdict, and the same lines.
//
// The schema is read from contracts/ when first needed, never copied: contracts/eval-set/eval-set.v1.schema.json and
// every schema it refers to by a relative $ref, file by file (K-01's bundle, K-02's model, K-08's event-trace and the
// shared formats).
//
// After the schema, the store's own rule: a human-labelled live turn (labelledBy human, a liveTurn seed) holds a real
// person's words, so it never enters the repository, a fixture or a test (BP rule 9; K-10 README "The seed state" and
// default 17). The store, kept under evals/gold/, takes walked items only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

/** The contracts/ folder: this file is evals/src/gold/store/validate.ts. */
export const CONTRACTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../contracts",
);

/** K-10 v1's schema, by its path under contracts/. */
export const K10_SCHEMA_FILE = "eval-set/eval-set.v1.schema.json";

/** The $defs entry of K-10 v1 a gold-set item is checked against. */
export const GOLD_ITEM_DEF = "goldItem";

/** How a schema's $id begins (contracts/README.md convention 2), for a $ref written as a full URI. */
const ID_PREFIX = "https://rosie.invalid/contracts/";

/** Where a gold field sits in an item: its problems also name the field (README "Every field value"). */
const FIELD_AT = /^(\/turns\/\d+\/label\/parts\/\d+\/fields\/\d+)(?:\/|$)/;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ajv's errors as one readable line each, as T-003's harness and contracts:check print them. */
export function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    let extra = "";
    if (error.keyword === "additionalProperties") {
      extra = ` (${String(error.params.additionalProperty)})`;
    } else if (error.keyword === "enum") {
      extra = ` (${(error.params.allowedValues as unknown[]).map(String).join(", ")})`;
    }
    return `${where} ${error.message ?? "is invalid"}${extra}`;
  });
}

/** Every `$ref` string under `node`. */
function refsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) refsOf(child, out);
  } else if (isObj(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else refsOf(value, out);
    }
  }
  return out;
}

/** The schema file a $ref names, by its path under contracts/, or null for a reference inside the same file. */
function refTarget(fromFile: string, ref: string): string | null {
  const target = ref.split("#")[0] ?? "";
  if (target === "") return null;
  const file = target.startsWith(ID_PREFIX)
    ? target.slice(ID_PREFIX.length)
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  if (file.startsWith("../") || path.posix.isAbsolute(file) || /^[a-z][a-z0-9+.-]*:/i.test(file))
    throw new Error(`contracts/${fromFile} refers to ${ref}, which is not a schema file under contracts/`);
  return file;
}

interface Loaded {
  /** K-10 v1 and every schema it refers to, K-10 first, by their paths under contracts/. */
  files: string[];
  validate: ValidateFunction;
}

let loaded: Loaded | null = null;

function load(): Loaded {
  if (loaded !== null) return loaded;
  // T-003's setup (tests/contract/_harness/fixtures.ts; contracts/scripts/lib.mjs).
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const files: string[] = [];
  const ids = new Map<string, string>();
  const visit = (file: string): void => {
    if (ids.has(file)) return;
    const schema: unknown = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8"));
    if (!isObj(schema) || typeof schema.$id !== "string")
      throw new Error(`contracts/${file} is not a schema object with an $id`);
    ajv.addSchema(schema);
    ids.set(file, schema.$id);
    files.push(file);
    for (const ref of refsOf(schema)) {
      const target = refTarget(file, ref);
      if (target !== null) visit(target);
    }
  };
  visit(K10_SCHEMA_FILE);
  const target = `${ids.get(K10_SCHEMA_FILE) ?? ""}#/$defs/${GOLD_ITEM_DEF}`;
  const validate = ajv.getSchema(target);
  if (validate === undefined) throw new Error(`Ajv cannot compile ${target}`);
  loaded = { files, validate };
  return loaded;
}

/** K-10 v1's schema and every schema it refers to, by their paths under contracts/ (posix), K-10 first. */
export function goldItemSchemaFiles(): string[] {
  return [...load().files];
}

/** The value at a JSON pointer inside `root` (`~1` is `/`, `~0` is `~`), or undefined. */
function at(root: unknown, pointer: string): unknown {
  let node = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)] as unknown;
    else if (isObj(node)) node = node[key];
    else return undefined;
  }
  return node;
}

/**
 * Ajv's lines for `value` against K-10 v1's goldItem (formatErrors), and the errors they come from. A line about a
 * gold field, or about something inside one, also names the field: `/turns/0/label/parts/0/fields/0 must have required
 * property 'value' (field "kinds")`. Empty: the schema accepts it.
 */
export function goldItemSchemaCheck(value: unknown): { errors: ErrorObject[]; problems: string[] } {
  const { validate } = load();
  if (validate(value)) return { errors: [], problems: [] };
  const errors = [...(validate.errors ?? [])];
  const lines = formatErrors(errors);
  const problems = errors.map((error, k) => {
    const line = lines[k] ?? "";
    const fieldPath = FIELD_AT.exec(error.instancePath)?.[1];
    const field = fieldPath === undefined ? undefined : at(value, fieldPath);
    const name = isObj(field) && typeof field.name === "string" ? field.name : undefined;
    return name === undefined ? line : `${line} (field ${JSON.stringify(name)})`;
  });
  return { errors, problems };
}

/** The store's own rules for an item K-10 v1 accepts (see the top of this file), one line each. */
function storeRuleProblems(item: Obj): string[] {
  const seed = item.seed;
  if (item.labelledBy === "walk" && !(isObj(seed) && seed.kind === "liveTurn")) return [];
  return [
    "/labelledBy is human (a liveTurn seed): a human-labelled live turn holds a real person's words, so it never " +
      "enters the repository, a fixture or a test (BP rule 9; K-10 README 'The seed state'); this store keeps walked items only",
  ];
}

/**
 * What is wrong with `value` as an item of the gold store: K-10 v1's goldItem first, then the store's own rule (a walked
 * item only, never a human-labelled live turn). One line each; empty: the store takes it.
 */
export function checkGoldItem(value: unknown): string[] {
  const { problems } = goldItemSchemaCheck(value);
  if (problems.length > 0) return problems;
  return storeRuleProblems(value as Obj);
}
