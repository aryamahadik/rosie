// The message-plan contract (K-03) as the composer's double reads it (T-1071; T-1175): the schema validator, the slot
// vocabulary and the fixtures, at one of the versions the double reads. One strict Ajv 2020-12 validator holds the
// shared formats, K-01's bundle schema (the plan's input refers to its stepId) and every K-03 schema: the setup of the
// contract harness (tests/contract/_harness/fixtures.ts) that T-082's contract test uses.
//
// K-03 v1.1 (T-1104) only adds: term facts in the composer's input, Rosie's own fixed terms that the step's card states,
// each with its source line (contracts/message-plan/README.md "v1.1"). Every v1 document is a v1.1 document, so the
// contract at v1.1 reads v1's fixtures and v1.1's, and the contract at v1 reads v1's alone, as it always has. Each
// version is read only once contracts/message-plan/frozen.json lists it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { CONTRACTS_ROOT } from "./contract";

const SCHEMA_FOLDERS = ["common", "bundle", "message-plan"] as const;
const PLAN_FOLDER = "message-plan";
const SLOTS_FIXTURE = "slots.json";

/** The K-03 versions the double reads, oldest first: each later one only adds to the one before (README "v1.1"). */
export const PLAN_VERSIONS = ["v1", "v1.1"] as const;
export type PlanVersion = (typeof PLAN_VERSIONS)[number];

export interface PlanFixtures {
  /**
   * One fixture's parsed JSON, fresh each call. Only a fixture the index lists, marks accept and gives a version this
   * contract reads (its own or an earlier one) can be read.
   */
  read(file: string): unknown;
}

export interface PlanContract {
  /** The K-03 version it reads. */
  readonly version: PlanVersion;
  /** The problems ajv finds in `value` against `$defs/<def>` of message-plan.<version>.schema.json, one line each; empty when accepted. */
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

/** The versions frozen.json lists; a K-03 version it does not list is never read. */
function frozenVersions(planDir: string): string[] {
  const raw = readJson(path.join(planDir, "frozen.json"));
  const list = isRecord(raw) ? raw.frozen : undefined;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string"))
    throw new Error("contracts/message-plan/frozen.json holds no frozen list");
  return list;
}

/**
 * Loads K-03's schema, slot vocabulary and fixtures at `version` (default v1, as the double read it before v1.1) from
 * `contractsRoot` (default: this repository's contracts/). Refuses a version the double does not read, or one
 * frozen.json does not list.
 */
export function loadPlanContract(
  contractsRoot: string = CONTRACTS_ROOT,
  version: PlanVersion = "v1",
): PlanContract {
  const at = PLAN_VERSIONS.indexOf(version);
  if (at < 0) throw new Error(`the double reads K-03 ${PLAN_VERSIONS.join(" and ")}, not ${version}`);
  const planDir = path.join(contractsRoot, PLAN_FOLDER);
  if (!frozenVersions(planDir).includes(version))
    throw new Error(
      `K-03 ${version} is not frozen (contracts/message-plan/frozen.json), so the double does not read it`,
    );
  /** The fixture versions this contract reads: its own and every earlier one, each a part of it. */
  const readable: readonly string[] = PLAN_VERSIONS.slice(0, at + 1);
  const schemaFile = `message-plan.${version}.schema.json`;

  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const folder of SCHEMA_FOLDERS) {
    const dir = path.join(contractsRoot, folder);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(dir, entry.name)) as object);
    }
  }
  const schema = readJson(path.join(planDir, schemaFile));
  if (!isRecord(schema) || typeof schema.$id !== "string") throw new Error(`${schemaFile} has no $id`);
  const schemaId = schema.$id;

  const fixturesDir = path.join(planDir, "fixtures");
  const entries = readFixtureIndex(fixturesDir);
  const fixtures: PlanFixtures = {
    read(file) {
      const entry = entries.find((candidate) => candidate.file === file);
      if (entry === undefined) throw new Error(`${file} is not listed in K-03's fixtures/index.json`);
      if (!readable.includes(entry.version))
        throw new Error(`${file} is a ${entry.version} fixture, not ${readable.join(" or ")}`);
      if (entry.expect !== "accept")
        throw new Error(`${file} is a fixture K-03 refuses, so it cannot seed a recording`);
      const absolute = path.join(fixturesDir, ...file.split("/"));
      if (!existsSync(absolute)) throw new Error(`${file} is listed in the index but does not exist`);
      return readJson(absolute);
    },
  };

  const validate = (def: string, value: unknown): string[] => {
    const validator = ajv.getSchema(`${schemaId}#/$defs/${def}`);
    if (validator === undefined) throw new Error(`${schemaFile} has no definition ${def}`);
    return validator(value) ? [] : formatErrors(validator.errors);
  };

  // The vocabulary is read from slots.json, checked as a slotVocabulary first so a damaged file refuses to load.
  const vocabulary = fixtures.read(SLOTS_FIXTURE);
  const problems = validate("slotVocabulary", vocabulary);
  if (problems.length > 0)
    throw new Error(`${SLOTS_FIXTURE} is not a slotVocabulary: ${problems.join("; ")}`);
  const slotNames = new Set((vocabulary as { slots: { name: string }[] }).slots.map((slot) => slot.name));

  return { version, validate, slotNames, fixtures };
}
