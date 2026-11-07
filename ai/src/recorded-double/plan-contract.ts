// The message-plan contract (K-03 v1) as the composer's double reads it (T-1071): the schema validator, the slot
// vocabulary and the fixtures. One strict Ajv 2020-12 validator holds the shared formats, K-01's bundle schema (the
// plan's input refers to its stepId) and K-03's schema: the setup of the contract harness
// (tests/contract/_harness/fixtures.ts) that T-082's contract test uses.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { CONTRACTS_ROOT } from "./contract";

const SCHEMA_FOLDERS = ["common", "bundle", "message-plan"] as const;
const PLAN_FOLDER = "message-plan";
const PLAN_SCHEMA = "message-plan.v1.schema.json";
const PLAN_VERSION = "v1";
const SLOTS_FIXTURE = "slots.json";

export interface PlanFixtures {
  /** One fixture's parsed JSON, fresh each call. Only a v1 fixture the index lists and marks accept can be read. */
  read(file: string): unknown;
}

export interface PlanContract {
  /** The problems ajv finds in `value` against `$defs/<def>` of message-plan.v1.schema.json, one line each; empty when accepted. */
  validate(def: string, value: unknown): string[];
  /** The slot vocabulary's names (fixtures/slots.json): every slot a plan's words may open. hold is not one (D66). */
  readonly slotNames: ReadonlySet<string>;
  readonly fixtures: PlanFixtures;
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

interface IndexEntry {
  readonly file: string;
  readonly version: string;
  readonly expect: "accept" | "refuse";
}

function readFixtureIndex(fixturesDir: string): IndexEntry[] {
  const raw = readJson(path.join(fixturesDir, "index.json"));
  const list = isRecord(raw) ? raw.fixtures : undefined;
  if (!Array.isArray(list))
    throw new Error("contracts/message-plan/fixtures/index.json holds no fixtures list");
  return list.map((entry: unknown): IndexEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.version !== "string" ||
      (entry.expect !== "accept" && entry.expect !== "refuse")
    )
      throw new Error(
        "contracts/message-plan/fixtures/index.json holds an entry without file, version or expect",
      );
    return { file: entry.file, version: entry.version, expect: entry.expect };
  });
}

/** Loads K-03 v1's schema, slot vocabulary and fixtures from `contractsRoot` (default: this repository's contracts/). */
export function loadPlanContract(contractsRoot: string = CONTRACTS_ROOT): PlanContract {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const folder of SCHEMA_FOLDERS) {
    const dir = path.join(contractsRoot, folder);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(dir, entry.name)) as object);
    }
  }
  const schema = readJson(path.join(contractsRoot, PLAN_FOLDER, PLAN_SCHEMA));
  if (!isRecord(schema) || typeof schema.$id !== "string") throw new Error(`${PLAN_SCHEMA} has no $id`);
  const schemaId = schema.$id;

  const fixturesDir = path.join(contractsRoot, PLAN_FOLDER, "fixtures");
  const entries = readFixtureIndex(fixturesDir);
  const fixtures: PlanFixtures = {
    read(file) {
      const entry = entries.find((candidate) => candidate.file === file);
      if (entry === undefined) throw new Error(`${file} is not listed in K-03's fixtures/index.json`);
      if (entry.version !== PLAN_VERSION) throw new Error(`${file} is a ${entry.version} fixture, not v1`);
      if (entry.expect !== "accept")
        throw new Error(`${file} is a fixture K-03 refuses, so it cannot seed a recording`);
      const absolute = path.join(fixturesDir, ...file.split("/"));
      if (!existsSync(absolute)) throw new Error(`${file} is listed in the index but does not exist`);
      return readJson(absolute);
    },
  };

  const validate = (def: string, value: unknown): string[] => {
    const validator = ajv.getSchema(`${schemaId}#/$defs/${def}`);
    if (validator === undefined) throw new Error(`${PLAN_SCHEMA} has no definition ${def}`);
    return validator(value) ? [] : formatErrors(validator.errors);
  };

  // The vocabulary is read from slots.json, checked as a slotVocabulary first so a damaged file refuses to load.
  const vocabulary = fixtures.read(SLOTS_FIXTURE);
  const problems = validate("slotVocabulary", vocabulary);
  if (problems.length > 0)
    throw new Error(`${SLOTS_FIXTURE} is not a slotVocabulary: ${problems.join("; ")}`);
  const slotNames = new Set((vocabulary as { slots: { name: string }[] }).slots.map((slot) => slot.name));

  return { validate, slotNames, fixtures };
}
