// K-01 v1's one validator, as the emitter uses it (T-149; contracts file section 2 item 8; contracts/README.md
// convention 8: Ajv 8, its 2020-12 class, strict mode, the same setup as contracts/scripts/lib.mjs and the contract
// tests).
//
// The schema is read from contracts/ when first needed, never copied: contracts/bundle/bundle.v1.schema.json and the
// shared formats it refers to (contracts/common/formats.v1.schema.json). The emitter checks every bundle it writes
// against the schema's root, and checks() any one $defs entry on demand (the refused fixtures are refused here).
//
// It also gives the per-step lint marks K-01 v1's own checks ask for (lintMarksOf). A compiled step that shows a lint
// failure in its own fields must list the rule in its `lint`, or the schema refuses the step (contracts/bundle/README.md,
// "The lint in the bundle"). The schema says which: each of its step checks names one rule (`lint` must contain it).
// lintMarksOf() checks the step with an empty `lint` and returns the rule each failing check names, read from the
// schema at the failing check's own path. So no rule (the slot list, the keyword list, the judgment-rule range) is
// written a second time here. The whole-graph rules and the full report are the lint's (C-065 to C-070; T-153 to T-160).
import { readFileSync } from "node:fs";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

/** The `$id` of K-01 v1. */
export const BUNDLE_SCHEMA_ID = "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json";

/** The schema files the validator loads, from contracts/: the shared formats first, then K-01 v1. */
export const SCHEMA_FILES: readonly string[] = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
];

const CONTRACTS_DIR = new URL("../../../contracts/", import.meta.url);

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value K-01 v1 refuses. `problems` holds one line per Ajv error. */
export class BundleValidationError extends Error {
  override name = "BundleValidationError";
  readonly problems: string[];

  constructor(where: string, problems: string[]) {
    const shown = problems.slice(0, 40).join("\n  ");
    const more = problems.length > 40 ? `\n  ... ${String(problems.length - 40)} more` : "";
    super(`${where} is refused by K-01 v1:\n  ${shown}${more}`);
    this.problems = problems;
  }
}

/** Ajv's errors as one readable line each (the lines contracts:check prints). */
export function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    let extra = "";
    if (error.keyword === "additionalProperties") extra = ` (${String(error.params.additionalProperty)})`;
    else if (error.keyword === "enum")
      extra = ` (${(error.params.allowedValues as unknown[]).map(String).join(", ")})`;
    return `${where} ${error.message ?? "is invalid"}${extra}`;
  });
}

interface Loaded {
  ajv: Ajv2020;
  schema: Obj;
  byDef: Map<string, ValidateFunction>;
}

let loaded: Loaded | null = null;

function load(): Loaded {
  if (loaded !== null) return loaded;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  let schema: Obj | null = null;
  for (const file of SCHEMA_FILES) {
    const parsed = JSON.parse(readFileSync(new URL(file, CONTRACTS_DIR), "utf8")) as unknown;
    if (!isObj(parsed)) throw new Error(`contracts/${file} does not hold a schema object`);
    ajv.addSchema(parsed);
    if (parsed.$id === BUNDLE_SCHEMA_ID) schema = parsed;
  }
  if (schema === null)
    throw new Error(`no schema with $id ${BUNDLE_SCHEMA_ID} in ${SCHEMA_FILES.join(", ")}`);
  loaded = { ajv, schema, byDef: new Map() };
  return loaded;
}

/** K-01 v1 as parsed from contracts/bundle/bundle.v1.schema.json (read once). Read only. */
export function bundleSchema(): Readonly<Obj> {
  return load().schema;
}

function validatorOf(def: string | null): ValidateFunction {
  const state = load();
  const key = def ?? "";
  const known = state.byDef.get(key);
  if (known !== undefined) return known;
  const defs = state.schema.$defs;
  if (def !== null && !(isObj(defs) && def in defs)) throw new Error(`K-01 v1 has no $defs entry "${def}"`);
  const validate = state.ajv.getSchema(def === null ? BUNDLE_SCHEMA_ID : `${BUNDLE_SCHEMA_ID}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`Ajv cannot compile K-01 v1 ${def ?? "(root)"}`);
  state.byDef.set(key, validate);
  return validate;
}

/**
 * The problems of `value` against K-01 v1: its root (a whole bundle, `def` left out) or one `$defs` entry (manifest,
 * flowGraph, tradeOverlay, step, ...). An empty list: accepted.
 */
export function checkBundlePart(value: unknown, def?: string): string[] {
  const validate = validatorOf(def ?? null);
  return validate(value) ? [] : formatErrors(validate.errors);
}

/** Throws BundleValidationError, naming `where`, when K-01 v1 refuses `value` (see checkBundlePart). */
export function assertBundlePart(value: unknown, where: string, def?: string): void {
  const problems = checkBundlePart(value, def);
  if (problems.length > 0) throw new BundleValidationError(where, problems);
}

/** The lint rules in K-01 v1's order (its `lintRule` enum). */
export function lintRuleOrder(): string[] {
  const defs = load().schema.$defs as Obj;
  const rule = defs.lintRule;
  if (!isObj(rule) || !Array.isArray(rule.enum)) throw new Error("K-01 v1 has no lintRule enum");
  return rule.enum.map(String);
}

/** The value at a JSON pointer's segments (`~1` is `/`, `~0` is `~`) inside `root`, or undefined. */
function at(root: unknown, segments: readonly string[]): unknown {
  let node = root;
  for (const raw of segments) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)] as unknown;
    else if (isObj(node)) node = node[key];
    else return undefined;
  }
  return node;
}

/** The rule a failing step check names: the `const` its `contains` asks `lint` for, read at the check's schema path. */
function ruleOfCheck(error: ErrorObject): string | null {
  if (error.keyword !== "contains" || !error.schemaPath.endsWith("/properties/lint/contains")) return null;
  const parts = error.schemaPath.replace(/^#\/?/, "").split("/");
  const fromRoot = parts[0] === "$defs";
  const schema = load().schema;
  const base = fromRoot ? schema : at(schema, ["$defs", "step"]);
  const check = at(base, parts);
  return isObj(check) && typeof check.const === "string" ? check.const : null;
}

/**
 * The lint rules K-01 v1's checks find on a compiled step's own fields (contracts/bundle/README.md, "The lint in the
 * bundle"), in K-01's order: the rules the step's `lint` must list for the schema to accept it. `step` is checked
 * with an empty `lint`; its other fields are not changed.
 */
export function lintMarksOf(step: Readonly<Obj>): string[] {
  const validate = validatorOf("step");
  if (validate({ ...step, lint: [] })) return [];
  const found = new Set<string>();
  for (const error of validate.errors ?? []) {
    const rule = ruleOfCheck(error);
    if (rule !== null) found.add(rule);
  }
  return lintRuleOrder().filter((rule) => found.has(rule));
}

/**
 * The rules K-01 v1's step schema checks, each with the step field whose presence starts the check (its
 * `dependentSchemas` key: say, vary, card, branches, walk, more). Read from the schema itself.
 */
export function stepSchemaChecks(): { field: string; rule: string }[] {
  const step = at(load().schema, ["$defs", "step"]);
  const dependents = isObj(step) ? step.dependentSchemas : undefined;
  if (!isObj(dependents)) throw new Error("K-01 v1's step has no dependentSchemas");
  const out: { field: string; rule: string }[] = [];
  const visit = (node: unknown, field: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, field);
      return;
    }
    if (!isObj(node)) return;
    const lint = at(node, ["properties", "lint", "contains", "const"]);
    if (typeof lint === "string" && !out.some((seen) => seen.field === field && seen.rule === lint))
      out.push({ field, rule: lint });
    for (const value of Object.values(node)) visit(value, field);
  };
  for (const [field, check] of Object.entries(dependents)) visit(check, field);
  return out;
}
