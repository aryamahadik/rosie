// Shared helpers for the contract scripts (T-006; ADR-005, docs/adr/0005-contract-format.md).
// ES module; uses only ajv from the root manifest.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

/** The contracts/ folder this script lives in. */
export const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every schema's $id is this base plus its path inside contracts/ (ADR-005). The .invalid name never resolves,
 * so no tool can fetch a schema over the network; a relative $ref between files resolves the same way from the
 * $id (Ajv) and from the file's place on disk (json-schema-to-typescript).
 */
export const ID_BASE = "https://rosie.invalid/contracts/";
export const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Folders under contracts/ that hold no contract and are never scanned. */
const SKIPPED = new Set(["node_modules", "generated"]);

/** Every file under `dir` (posix paths relative to `dir`), sorted, skipping node_modules/ and generated/. */
export function listFiles(dir) {
  const out = [];
  const walk = (relative) => {
    const entries = readdirSync(path.join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };
  walk("");
  return out.sort();
}

export const isSchemaFile = (file) => file.endsWith(".schema.json");
export const isMetaSchemaFile = (file) => file.endsWith(".meta.schema.json");
export const isTablesFile = (file) => file.endsWith(".tables.json");

/** The $id a schema at `file` (relative to contracts/) must carry. */
export const idFor = (file) => `${ID_BASE}${file}`;

/** Reads and parses a JSON file; throws an Error naming the file when it is not valid JSON. */
export function readJson(absolute, shown = absolute) {
  const text = readFileSync(absolute, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${shown} is not valid JSON: ${error.message}`, { cause: error });
  }
}

/** A JSON Schema 2020-12 validator in strict mode, reporting every error. */
export function createAjv() {
  return new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
}

/** Ajv's errors as one readable line each. */
export function formatErrors(errors) {
  return (errors ?? []).map((error) => {
    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    const extra =
      error.keyword === "additionalProperties"
        ? ` (${error.params.additionalProperty})`
        : error.keyword === "enum"
          ? ` (${error.params.allowedValues.join(", ")})`
          : "";
    return `${where} ${error.message}${extra}`;
  });
}
