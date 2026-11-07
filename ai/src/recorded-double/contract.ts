// The model contract (K-02 v1) as the double reads it (T-004): the schema validator, the two named rules and the
// fixtures. One strict Ajv 2020-12 validator holds the shared formats, K-01's bundle schema and K-02's schema, the same
// setup as the contract harness (tests/contract/_harness/fixtures.ts) that T-081's contract test uses.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

/** The repository root: this file is ai/src/recorded-double/contract.ts. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CONTRACTS_ROOT = path.join(REPO_ROOT, "contracts");
export const RECORDINGS_ROOT = path.join(REPO_ROOT, "ai", "recordings");

const SCHEMA_FOLDERS = ["common", "bundle", "model"] as const;
const MODEL_SCHEMA = "model.v1.schema.json";
const MODEL_VERSION = "v1";

/** A named rule of model.rules.mjs: it takes a context with a decide result and returns one line per problem. */
export type NamedRule = (pair: { context: unknown; decide: unknown }) => string[];

export interface ModelFixtureEntry {
  readonly file: string;
  readonly version: string;
  readonly def: string | undefined;
  readonly expect: "accept" | "refuse";
}

export interface ModelFixtures {
  /** Every entry of fixtures/index.json. */
  readonly entries: readonly ModelFixtureEntry[];
  /** One fixture's parsed JSON, fresh each call. Only a v1 fixture the index lists and marks accept can be read. */
  read(file: string): unknown;
}

export interface ModelContract {
  /** The problems ajv finds in `value` against `$defs/<def>` of model.v1.schema.json, one line each; empty when accepted. */
  validate(def: string, value: unknown): string[];
  /** The named rules, by name (optionOffered, quoteInText). */
  readonly rules: Readonly<Record<string, NamedRule>>;
  readonly fixtures: ModelFixtures;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    const extra =
      error.keyword === "additionalProperties"
        ? ` (${String(error.params.additionalProperty)})`
        : error.keyword === "enum"
          ? ` (${(error.params.allowedValues as unknown[]).map(String).join(", ")})`
          : "";
    return `${where} ${error.message ?? "is invalid"}${extra}`;
  });
}

function readFixtureIndex(fixturesDir: string): ModelFixtureEntry[] {
  const raw = readJson(path.join(fixturesDir, "index.json"));
  const list = isRecord(raw) ? raw.fixtures : undefined;
  if (!Array.isArray(list)) throw new Error("contracts/model/fixtures/index.json holds no fixtures list");
  return list.map((entry: unknown): ModelFixtureEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.version !== "string" ||
      (entry.expect !== "accept" && entry.expect !== "refuse")
    )
      throw new Error("contracts/model/fixtures/index.json holds an entry without file, version or expect");
    return {
      file: entry.file,
      version: entry.version,
      def: typeof entry.def === "string" ? entry.def : undefined,
      expect: entry.expect,
    };
  });
}

/** Loads K-02 v1's schema, named rules and fixtures from `contractsRoot` (default: this repository's contracts/). */
export async function loadModelContract(contractsRoot: string = CONTRACTS_ROOT): Promise<ModelContract> {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const folder of SCHEMA_FOLDERS) {
    const dir = path.join(contractsRoot, folder);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(dir, entry.name)) as object);
    }
  }
  const schema = readJson(path.join(contractsRoot, "model", MODEL_SCHEMA));
  if (!isRecord(schema) || typeof schema.$id !== "string") throw new Error(`${MODEL_SCHEMA} has no $id`);
  const schemaId = schema.$id;

  const rulesFile = path.join(contractsRoot, "model", "model.rules.mjs");
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(rulesFile).href)) as {
    rules: Record<string, NamedRule>;
  };

  const fixturesDir = path.join(contractsRoot, "model", "fixtures");
  const entries = readFixtureIndex(fixturesDir);
  const fixtures: ModelFixtures = {
    entries,
    read(file) {
      const entry = entries.find((candidate) => candidate.file === file);
      if (entry === undefined) throw new Error(`${file} is not listed in K-02's fixtures/index.json`);
      if (entry.version !== MODEL_VERSION) throw new Error(`${file} is a ${entry.version} fixture, not v1`);
      if (entry.expect !== "accept")
        throw new Error(`${file} is a fixture K-02 refuses, so it cannot seed a recording`);
      const absolute = path.join(fixturesDir, ...file.split("/"));
      if (!existsSync(absolute)) throw new Error(`${file} is listed in the index but does not exist`);
      return readJson(absolute);
    },
  };

  return {
    validate(def, value) {
      const validator = ajv.getSchema(`${schemaId}#/$defs/${def}`);
      if (validator === undefined) throw new Error(`model.v1.schema.json has no definition ${def}`);
      return validator(value) ? [] : formatErrors(validator.errors);
    },
    rules: loaded.rules,
    fixtures,
  };
}
