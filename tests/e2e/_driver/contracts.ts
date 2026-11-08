// The frozen contracts the end-to-end driver reads (T-465; C-148), checked with one JSON Schema 2020-12 validator: the
// strict Ajv setup of contracts/scripts/lib.mjs and the shared harness (T-003). Every schema file under contracts/ is
// loaded once, so a $ref between contracts resolves (K-21 v1 refers to K-08, K-09, K-11 and others).
//
// Problem lines are Ajv's, one per error, by place and rule (formatErrors): they never carry the value checked, so no
// message words, phone number or token reaches a report.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { CONTRACTS_ROOT, formatErrors } from "../../contract/_harness";

/** Folders of contracts/ that hold no contract schema the driver reads. */
const SKIPPED = new Set(["node_modules", "generated", "scripts"]);

type Ajv = InstanceType<typeof Ajv2020>;

interface Loaded {
  readonly ajv: Ajv;
  /** "<folder>/<file>" (posix) -> the schema's $id. */
  readonly ids: ReadonlyMap<string, string>;
}

let loaded: Loaded | undefined;
const validators = new Map<string, ValidateFunction>();

function schemaFiles(dir: string, relative = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) out.push(...schemaFiles(dir, child));
    } else if (entry.isFile() && entry.name.endsWith(".schema.json")) {
      out.push(child);
    }
  }
  return out.sort();
}

function load(): Loaded {
  if (loaded !== undefined) return loaded;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const ids = new Map<string, string>();
  const seen = new Set<string>();
  for (const file of schemaFiles(CONTRACTS_ROOT)) {
    const schema = JSON.parse(readFileSync(path.join(CONTRACTS_ROOT, ...file.split("/")), "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof schema.$id !== "string" || seen.has(schema.$id)) continue;
    ajv.addSchema(schema);
    seen.add(schema.$id);
    ids.set(file, schema.$id);
  }
  loaded = { ajv, ids };
  return loaded;
}

/**
 * The validator of one contract definition: `file` is the schema's path under contracts/ ("event-trace/
 * event-trace.v1.schema.json"), `def` a name under its $defs, or the schema's root when left out.
 */
export function validatorOf(file: string, def?: string): ValidateFunction {
  const key = `${file}#${def ?? ""}`;
  const known = validators.get(key);
  if (known !== undefined) return known;
  const { ajv, ids } = load();
  const id = ids.get(file);
  if (id === undefined) throw new Error(`contracts/${file} is not a schema the driver can load`);
  const validate = ajv.getSchema(def === undefined ? id : `${id}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`contracts/${file} has no definition "${def ?? ""}"`);
  validators.set(key, validate);
  return validate;
}

/** The problems of `value` against one contract definition, one line each; empty when it passes. */
export function schemaProblems(file: string, def: string | undefined, value: unknown): string[] {
  const validate = validatorOf(file, def);
  return validate(value) ? [] : formatErrors(validate.errors);
}

/** K-08 v1 (frozen, T-017): the trace format. */
export const K08 = "event-trace/event-trace.v1.schema.json";
/** K-07 v1 (frozen, T-016): outbox rows and effect rows. */
export const K07 = "outbox-effects/outbox-effects.v1.schema.json";
/** K-21 v1 (frozen, T-030): the page and console calls, the staging-only test-phone calls among them. */
export const K21 = "page-api/page-api.v1.schema.json";

/** K-07's named rule: one record's moves chain together under the retry rules (contracts/outbox-effects README). */
export type LifeChain = (record: unknown) => string[];

let lifeChainRule: LifeChain | undefined;

/** Loads K-07 v1's named rule `lifeChain` from contracts/outbox-effects/outbox-effects.rules.mjs. */
export async function lifeChain(): Promise<LifeChain> {
  if (lifeChainRule !== undefined) return lifeChainRule;
  const file = path.join(CONTRACTS_ROOT, "outbox-effects", "outbox-effects.rules.mjs");
  const rules = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { lifeChain?: unknown };
  if (typeof rules.lifeChain !== "function") throw new Error("K-07's rules file has no lifeChain rule");
  const rule = rules.lifeChain as (record: unknown) => unknown;
  lifeChainRule = (record) => {
    const problems = rule(record);
    return Array.isArray(problems) ? problems.map(String) : ["lifeChain gave no list of problems"];
  };
  return lifeChainRule;
}
