// Contract-fixture harness (T-003; 02-contracts section 2 items 5, 8 and 12; contracts/README.md conventions 5 and 8).
//
// A contract test (tests/contract/<name>.v<N>.test.ts) calls describeContractFixtures("<name>") once. It reads
// contracts/<name>/fixtures/index.json, checks each listed fixture against its schema with one JSON Schema
// 2020-12 validator (Ajv 8, its 2020-12 class, strict mode: the same setup as contracts/scripts/lib.mjs), and
// fails when
//   - an accepted fixture is refused by its schema, or a refused fixture is accepted (no silent pass);
//   - a .json file in fixtures/ is not listed in index.json, or a listed file does not exist;
//   - the index is not valid JSON or does not match common/fixtures-index.meta.schema.json;
//   - the index lists nothing at all (a contract test that checks no fixture proves nothing).
// An entry checks against <name>.<version>.schema.json unless it names another `schema`, and against the
// schema's root unless it names a `def` under $defs. A database seed row (an entry with `table`) is left to the
// part's own contract test (item 12): it is counted in the report, never checked here.
//
// checkContractFixtures does the work and returns a report; it never throws for a problem in the contract's
// files, so the harness's own tests can look at every kind of failure. describeContractFixtures turns a report
// into Vitest tests.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

/** The repository root: this file is tests/contract/_harness/fixtures.ts. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The contracts/ folder: one folder per contract, plus common/. */
export const CONTRACTS_ROOT = path.join(REPO_ROOT, "contracts");

const FIXTURES_META = "common/fixtures-index.meta.schema.json";
const SKIPPED_FOLDERS = new Set(["node_modules", "generated"]);
const SCHEMA_VERSION = /[.](v[0-9]+(?:[.][0-9]+)?)[.]schema[.]json$/;

export type Expectation = "accept" | "refuse";

/** One entry of fixtures/index.json (shape: contracts/common/fixtures-index.meta.schema.json). */
export interface FixtureEntry {
  file: string;
  version: string;
  schema?: string;
  def?: string;
  table?: string;
  expect: Expectation;
  shows: string;
  source: string;
}

export interface EntryResult {
  /** The fixture's path inside fixtures/. */
  file: string;
  expect: Expectation;
  version: string;
  /** The schema file that checked it, or null for a seed row. */
  schema: string | null;
  def: string | null;
  /** "accepted" or "refused": what the schema did. "seed-row": left to the database part's test. "error": it could not be checked. */
  outcome: "accepted" | "refused" | "seed-row" | "error";
  /** True when the outcome is what the index marks (a seed row is true: it is not checked here). */
  ok: boolean;
  /** One line per reason it is not ok; empty when ok. */
  problems: string[];
}

export interface FixtureReport {
  /** The contract's name: its folder's name. */
  contract: string;
  /** The contract's folder (absolute). */
  dir: string;
  entries: EntryResult[];
  /** Problems with the index or the folder as a whole (not with one entry). */
  problems: string[];
  /** Entries marked accept that the schema accepted. */
  passes: number;
  /** Entries marked refuse that the schema refused. */
  refusals: number;
  /** Entries for a database seed row, left to the part's contract test. */
  seedRows: number;
  /** True when no problem is found anywhere. */
  ok: boolean;
}

export interface FixtureOptions {
  /** The contracts/ folder that holds the shared schemas. Default: this repository's contracts/. */
  contractsRoot?: string;
  /** Folders of contractsRoot whose schemas the contract may $ref. Default: ["common"]. */
  sharedFolders?: readonly string[];
}

/** Ajv's errors as one readable line each (the same lines contracts:check prints). */
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

/** Every file under `dir` (posix paths relative to `dir`), sorted, skipping node_modules/ and generated/. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };
  walk("");
  return out.sort();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The folder of contract `name` under contracts/ (or under `contractsRoot`).
 * A path that is already absolute is returned as it is.
 */
export function contractDir(name: string, contractsRoot = CONTRACTS_ROOT): string {
  return path.isAbsolute(name) ? name : path.join(contractsRoot, name);
}

/** Checks one contract's fixtures; see the header. `contract` is a folder name under contracts/ or an absolute path. */
export function checkContractFixtures(contract: string, options: FixtureOptions = {}): FixtureReport {
  const contractsRoot = options.contractsRoot ?? CONTRACTS_ROOT;
  const sharedFolders = options.sharedFolders ?? ["common"];
  const dir = contractDir(contract, contractsRoot);
  const name = path.basename(dir);
  const fixturesDir = path.join(dir, "fixtures");
  const indexPath = path.join(fixturesDir, "index.json");
  const report: FixtureReport = {
    contract: name,
    dir,
    entries: [],
    problems: [],
    passes: 0,
    refusals: 0,
    seedRows: 0,
    ok: false,
  };
  const finish = (): FixtureReport => {
    report.ok = report.problems.length === 0 && report.entries.every((entry) => entry.ok);
    return report;
  };
  const fail = (message: string): void => {
    report.problems.push(message);
  };

  // One validator for everything: the strict Ajv 2020-12 setup of contracts/scripts/lib.mjs.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });

  // Schemas: the shared folders first, then the contract's own, each file once (a contract inside contractsRoot
  // may also be listed as shared). Loaded together so a $ref between files resolves whatever the order.
  const schemaIds = new Map<string, string>(); // absolute path -> $id
  const addFolder = (folder: string): void => {
    if (!existsSync(folder)) return;
    for (const file of listFiles(folder)) {
      if (!file.endsWith(".schema.json")) continue;
      const absolute = path.join(folder, file);
      if (schemaIds.has(absolute)) continue;
      try {
        const schema: unknown = JSON.parse(readFileSync(absolute, "utf8"));
        if (!isObject(schema) || typeof schema.$id !== "string") {
          fail(`${absolute}: a schema must be a JSON object with an "$id"`);
          continue;
        }
        ajv.addSchema(schema);
        schemaIds.set(absolute, schema.$id);
      } catch (error) {
        fail(`${absolute}: could not be loaded: ${describeError(error)}`);
      }
    }
  };
  for (const folder of sharedFolders) addFolder(path.join(contractsRoot, folder));
  addFolder(dir);

  // The index.
  if (!existsSync(indexPath)) {
    fail(`${indexPath} does not exist: a contract lists its fixtures in fixtures/index.json`);
    return finish();
  }
  let index: unknown;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    fail(`${indexPath} is not valid JSON: ${describeError(error)}`);
    return finish();
  }
  const metaId = schemaIds.get(path.join(contractsRoot, FIXTURES_META));
  const checkIndex = metaId === undefined ? undefined : ajv.getSchema(metaId);
  if (checkIndex === undefined) {
    fail(`${path.join(contractsRoot, FIXTURES_META)} is missing: the harness needs it to read index.json`);
    return finish();
  }
  if (!checkIndex(index)) {
    for (const line of formatErrors(checkIndex.errors)) fail(`fixtures/index.json: ${line}`);
    return finish();
  }
  const entries = (index as { fixtures: FixtureEntry[] }).fixtures;
  if (entries.length === 0)
    fail("fixtures/index.json lists no fixture: the contract test would prove nothing");

  const listed = new Set<string>();
  for (const entry of entries) {
    const result: EntryResult = {
      file: entry.file,
      expect: entry.expect,
      version: entry.version,
      schema: null,
      def: entry.def ?? null,
      outcome: "error",
      ok: false,
      problems: [],
    };
    report.entries.push(result);
    const stop = (message: string): void => {
      result.problems.push(message);
    };
    if (listed.has(entry.file)) stop(`${entry.file} is listed twice in fixtures/index.json`);
    listed.add(entry.file);
    const fixturePath = path.join(fixturesDir, ...entry.file.split("/"));
    if (!existsSync(fixturePath)) {
      stop(`fixtures/index.json lists ${entry.file}, which does not exist`);
      continue;
    }
    if (entry.table !== undefined) {
      result.outcome = "seed-row";
      report.seedRows += 1;
      continue;
    }
    const schemaName = entry.schema ?? `${name}.${entry.version}.schema.json`;
    result.schema = schemaName;
    const schemaPath = path.join(dir, schemaName);
    const schemaId = schemaIds.get(schemaPath);
    if (schemaId === undefined) {
      stop(`its schema ${schemaName} does not exist in ${name}/ (or did not load)`);
      continue;
    }
    if (SCHEMA_VERSION.exec(schemaName)?.[1] !== entry.version) {
      stop(`is listed for ${entry.version} but checked against ${schemaName}`);
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(fixturePath, "utf8"));
    } catch (error) {
      stop(`${entry.file} is not valid JSON: ${describeError(error)}`);
      continue;
    }
    const target = `${schemaId}${entry.def === undefined ? "" : `#/$defs/${entry.def}`}`;
    let validate: ValidateFunction | undefined;
    try {
      validate = ajv.getSchema(target);
    } catch (error) {
      stop(`cannot check against ${target}: ${describeError(error)}`);
      continue;
    }
    if (validate === undefined) {
      stop(`${schemaName} has no definition "${entry.def ?? ""}" under $defs`);
      continue;
    }
    const valid = validate(payload);
    const where = `${schemaName}${entry.def === undefined ? "" : ` #/$defs/${entry.def}`}`;
    result.outcome = valid ? "accepted" : "refused";
    if (entry.expect === "accept") {
      if (valid) {
        report.passes += 1;
      } else {
        stop(`${entry.file} must be accepted by ${where}, but is refused:`);
        for (const line of formatErrors(validate.errors)) stop(`  ${line}`);
      }
    } else if (valid) {
      stop(`${entry.file} must be refused by ${where} (it shows: ${entry.shows}), but is accepted`);
    } else {
      report.refusals += 1;
    }
  }

  // A .json file in fixtures/ that the index does not list.
  for (const file of listFiles(fixturesDir)) {
    if (file === "index.json" || !file.endsWith(".json")) continue;
    if (!listed.has(file)) fail(`fixtures/${file} is not listed in fixtures/index.json`);
  }
  for (const result of report.entries) result.ok = result.problems.length === 0 && result.outcome !== "error";
  return finish();
}

/**
 * Registers the Vitest tests of one contract's fixtures: one test for the index as a whole, then one per
 * checked fixture ("accepts <file>" or "refuses <file>"). A seed row gets no test here.
 */
export function describeContractFixtures(contract: string, options: FixtureOptions = {}): FixtureReport {
  const report = checkContractFixtures(contract, options);
  describe(`${report.contract} fixtures`, () => {
    it("has a valid fixtures/index.json that lists every fixture file and every file it lists", () => {
      expect(report.problems).toEqual([]);
    });
    for (const entry of report.entries) {
      if (entry.outcome === "seed-row") continue;
      it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file}`, () => {
        expect(entry.problems).toEqual([]);
        expect(entry.ok).toBe(true);
      });
    }
  });
  return report;
}
