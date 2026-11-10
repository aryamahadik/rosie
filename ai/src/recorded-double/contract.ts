// The model contract (K-02) as the double reads it (T-004; T-1145): the schema validator, the two named rules and the
// fixtures, at one of the versions the double reads. One strict Ajv 2020-12 validator holds the shared formats, K-01's
// bundle schema and every K-02 schema, the same setup as the contract harness (tests/contract/_harness/fixtures.ts) that
// T-081's contract test uses.
//
// K-02 v1.1 (T-1142) only adds: the sign-up door, signUp, to S1-01, for the walking skeleton's turn 1. Every v1 payload
// is a v1.1 payload (contracts/model/README.md "v1.1"), so the contract at v1.1 reads v1's fixtures and v1.1's, and the
// contract at v1 reads v1's alone, as it always has. Each version is read only once contracts/model/frozen.json lists it.

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

/** The K-02 versions the double reads, oldest first: each later one only adds to the one before (README "v1.1"). */
export const MODEL_VERSIONS = ["v1", "v1.1"] as const;
export type ModelVersion = (typeof MODEL_VERSIONS)[number];

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
  /**
   * One fixture's parsed JSON, fresh each call. Only a fixture the index lists, marks accept and gives a version this
   * contract reads (its own or an earlier one) can be read.
   */
  read(file: string): unknown;
}

export interface ModelContract {
  /** The K-02 version it reads. */
  readonly version: ModelVersion;
  /** The problems ajv finds in `value` against `$defs/<def>` of model.<version>.schema.json, one line each; empty when accepted. */
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

/** The versions frozen.json lists; a K-02 version it does not list is never read. */
function frozenVersions(modelDir: string): string[] {
  const raw = readJson(path.join(modelDir, "frozen.json"));
  const list = isRecord(raw) ? raw.frozen : undefined;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string"))
    throw new Error("contracts/model/frozen.json holds no frozen list");
  return list;
}

/**
 * Loads K-02's schema, named rules and fixtures at `version` (default v1, as the double read it before v1.1) from
 * `contractsRoot` (default: this repository's contracts/). Refuses a version the double does not read, or one
 * frozen.json does not list.
 */
export async function loadModelContract(
  contractsRoot: string = CONTRACTS_ROOT,
  version: ModelVersion = "v1",
): Promise<ModelContract> {
  const at = MODEL_VERSIONS.indexOf(version);
  if (at < 0) throw new Error(`the double reads K-02 ${MODEL_VERSIONS.join(" and ")}, not ${version}`);
  const modelDir = path.join(contractsRoot, "model");
  if (!frozenVersions(modelDir).includes(version))
    throw new Error(
      `K-02 ${version} is not frozen (contracts/model/frozen.json), so the double does not read it`,
    );
  /** The fixture versions this contract reads: its own and every earlier one, each a part of it. */
  const readable: readonly string[] = MODEL_VERSIONS.slice(0, at + 1);
  const schemaFile = `model.${version}.schema.json`;

  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const folder of SCHEMA_FOLDERS) {
    const dir = path.join(contractsRoot, folder);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(dir, entry.name)) as object);
    }
  }
  const schema = readJson(path.join(modelDir, schemaFile));
  if (!isRecord(schema) || typeof schema.$id !== "string") throw new Error(`${schemaFile} has no $id`);
  const schemaId = schema.$id;

  const rulesFile = path.join(modelDir, "model.rules.mjs");
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(rulesFile).href)) as {
    rules: Record<string, NamedRule>;
  };

  const fixturesDir = path.join(modelDir, "fixtures");
  const entries = readFixtureIndex(fixturesDir);
  const fixtures: ModelFixtures = {
    entries,
    read(file) {
      const entry = entries.find((candidate) => candidate.file === file);
      if (entry === undefined) throw new Error(`${file} is not listed in K-02's fixtures/index.json`);
      if (!readable.includes(entry.version))
        throw new Error(`${file} is a ${entry.version} fixture, not ${readable.join(" or ")}`);
      if (entry.expect !== "accept")
        throw new Error(`${file} is a fixture K-02 refuses, so it cannot seed a recording`);
      const absolute = path.join(fixturesDir, ...file.split("/"));
      if (!existsSync(absolute)) throw new Error(`${file} is listed in the index but does not exist`);
      return readJson(absolute);
    },
  };

  return {
    version,
    validate(def, value) {
      const validator = ajv.getSchema(`${schemaId}#/$defs/${def}`);
      if (validator === undefined) throw new Error(`${schemaFile} has no definition ${def}`);
      return validator(value) ? [] : formatErrors(validator.errors);
    },
    rules: loaded.rules,
    fixtures,
  };
}
