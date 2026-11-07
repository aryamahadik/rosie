#!/usr/bin/env node
// Contract check: `npm run contracts:check` runs `npm run check --workspace contracts` (T-006; ADR-005;
// 02-contracts section 2 items 1 to 5, 10 and 11). ES module; uses ajv from the root manifest.
//
// Under contracts/ (generated/ and node_modules/ left out) it checks:
//   - every *.schema.json: JSON Schema 2020-12 that compiles in Ajv's strict mode, whose $id is
//     https://rosie.invalid/contracts/<its path>, and, in a contract folder, whose name is <folder>.v<N>[.<m>].schema.json;
//   - every fixtures/index.json against common/fixtures-index.meta.schema.json, then every fixture it lists against
//     its schema (or one $defs entry of it): "accept" must pass, "refuse" must fail. An accepted fixture must also pass
//     every later minor version of the same schema (BP 6.4: a minor version only adds). Every .json file in fixtures/
//     must be listed. A database seed row (an entry with "table") is left to its part's contract test. An entry that
//     names a "rule" (T-011) must pass its schema, and then the named rule, exported by contracts/<name>/<name>.rules.mjs,
//     decides it: "accept" must pass the rule, "refuse" must fail it, so the fixture is refused for that rule alone;
//   - every frozen.json against common/frozen.meta.schema.json, only at contracts/<name>/frozen.json or at
//     contracts/db-schema/<part>/frozen.json (the guard takes a file's nearest frozen.json, so a part's own file
//     governs that part alone; T-1061), with a file for each frozen version: for a part, its table list of that
//     version in the part's own folder;
//   - every *.tables.json against db-schema/tables.meta.schema.json, and that each column a key, constraint, index,
//     row-level security scope, version, effective-date or sealing entry names exists in its table.
//
// Usage: node scripts/check-fixtures.mjs [--contracts <dir>]   (default: the contracts/ folder above this script)
// Exit code: 0 passed, 1 failed.

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrozen, versionOfFile } from "../../infra/ci/contract-freeze-guard.mjs";
import {
  CONTRACTS_DIR,
  DIALECT,
  createAjv,
  formatErrors,
  idFor,
  isMetaSchemaFile,
  isSchemaFile,
  isTablesFile,
  listFiles,
  readJson,
} from "./lib.mjs";

const FIXTURES_META = "common/fixtures-index.meta.schema.json";
const FROZEN_META = "common/frozen.meta.schema.json";
const TABLES_META = "db-schema/tables.meta.schema.json";
const VERSIONED_NAME = /^(.+)\.v(\d+)(?:\.(\d+))?\.(schema|tables)\.json$/;

const posixDir = (file) => path.posix.dirname(file);
const baseName = (file) => path.posix.basename(file);
const requireModule = createRequire(import.meta.url);

/**
 * The named rules of the contract in `contractDir` (contracts-relative): the `rules` object its
 * <name>.rules.mjs exports, loaded synchronously (require of an ES module, Node 22.12 and later).
 * @returns {{ rules?: Record<string, (payload: unknown) => string[]>, problem?: string }}
 */
export function loadRules(contractsDir, contractDir) {
  const file = `${contractDir}/${baseName(contractDir)}.rules.mjs`;
  const absolute = path.join(contractsDir, file);
  if (!existsSync(absolute)) return { problem: `${file} does not exist` };
  try {
    const loaded = requireModule(absolute);
    if (loaded.rules === null || typeof loaded.rules !== "object") {
      return { problem: `${file} exports no "rules" object` };
    }
    return { rules: loaded.rules };
  } catch (error) {
    return { problem: `${file} could not be loaded: ${error.message}` };
  }
}

/** Splits "contracts-relative/x.v1.2.schema.json" into its name, major and minor; undefined if unversioned. */
function versionedName(file) {
  const match = VERSIONED_NAME.exec(baseName(file));
  if (match === null) return undefined;
  return { name: match[1], major: Number(match[2]), minor: match[3] === undefined ? 0 : Number(match[3]) };
}

/**
 * The folder a frozen.json at `file` (contracts-relative) governs, as "<name>/" or "db-schema/<part>/"; undefined
 * where the convention puts no frozen.json. The guard reads the nearest frozen.json between a file's folder and
 * contracts/<name>/ (T-1061); the convention allows exactly two places, so a freeze is never hidden in a fixtures/
 * folder or below a part.
 */
export function frozenFolder(file) {
  const parts = file.split("/");
  if (parts[parts.length - 1] !== "frozen.json") return undefined;
  if (parts.length === 2 && parts[0] !== "scripts") return `${parts[0]}/`;
  if (parts.length === 3 && parts[0] === "db-schema" && parts[1] !== "fixtures") {
    return `db-schema/${parts[1]}/`;
  }
  return undefined;
}

/**
 * Runs every check on one contracts/ folder.
 * @returns {{ errors: string[], counts: Record<string, number> }}
 */
export function checkContracts(contractsDir = CONTRACTS_DIR) {
  const errors = [];
  const counts = {
    schemas: 0,
    accepted: 0,
    refused: 0,
    refusedByRule: 0,
    seedRows: 0,
    tableLists: 0,
    frozen: 0,
  };
  const rulesByContract = new Map(); // contract folder -> loadRules() result
  const fail = (file, message) => errors.push(`${file}: ${message}`);
  const files = listFiles(contractsDir);
  const fileSet = new Set(files);
  const read = (file) => readJson(path.join(contractsDir, file), file);
  const ajv = createAjv();

  // 1. Schemas: load all first, so a $ref between files resolves whatever the order.
  const schemas = new Map(); // file -> parsed schema
  for (const file of files.filter(isSchemaFile)) {
    let schema;
    try {
      schema = read(file);
    } catch (error) {
      fail(file, error.message);
      continue;
    }
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      fail(file, "a schema file must hold a JSON object");
      continue;
    }
    if (schema.$schema !== DIALECT) fail(file, `"$schema" must be "${DIALECT}" (JSON Schema 2020-12)`);
    if (schema.$id !== idFor(file)) fail(file, `"$id" must be "${idFor(file)}"`);
    if (!isMetaSchemaFile(file)) {
      const named = versionedName(file);
      const parts = file.split("/");
      if (named === undefined) {
        fail(file, "a schema file is named <name>.v<N>.schema.json or <name>.v<N>.<m>.schema.json");
      } else if (parts[0] !== "common" && named.name !== baseName(posixDir(file))) {
        fail(
          file,
          `a contract's schema file is named after its folder: ${baseName(posixDir(file))}.v<N>.schema.json`,
        );
      }
    }
    try {
      ajv.addSchema(schema);
      schemas.set(file, schema);
    } catch (error) {
      fail(file, `could not be added: ${error.message}`);
    }
  }
  for (const [file, schema] of schemas) {
    try {
      ajv.getSchema(schema.$id);
      counts.schemas += 1;
    } catch (error) {
      fail(file, `does not compile: ${error.message}`);
    }
  }
  const metaValidator = (file) => {
    if (!schemas.has(file)) {
      fail(file, "is missing; the contract checks need it");
      return undefined;
    }
    try {
      return ajv.getSchema(idFor(file));
    } catch {
      return undefined; // already reported above
    }
  };

  // 2. Fixtures.
  const checkIndex = metaValidator(FIXTURES_META);
  for (const indexFile of files.filter(
    (file) => baseName(file) === "index.json" && baseName(posixDir(file)) === "fixtures",
  )) {
    const fixturesDir = posixDir(indexFile);
    const contractDir = posixDir(fixturesDir);
    const contractName = baseName(contractDir);
    let index;
    try {
      index = read(indexFile);
    } catch (error) {
      fail(indexFile, error.message);
      continue;
    }
    if (checkIndex !== undefined && !checkIndex(index)) {
      for (const line of formatErrors(checkIndex.errors)) fail(indexFile, line);
      continue;
    }
    const listed = new Set();
    for (const entry of index.fixtures ?? []) {
      const fixture = `${fixturesDir}/${entry.file}`;
      if (listed.has(entry.file)) fail(indexFile, `lists ${entry.file} twice`);
      listed.add(entry.file);
      if (!fileSet.has(fixture)) {
        fail(indexFile, `lists ${entry.file}, which does not exist`);
        continue;
      }
      if (entry.table !== undefined) {
        counts.seedRows += 1; // checked by the database part's contract test (item 12)
        continue;
      }
      const schemaName = entry.schema ?? `${contractName}.${entry.version}.schema.json`;
      const schemaFile = `${contractDir}/${schemaName}`;
      if (!schemas.has(schemaFile)) {
        fail(fixture, `its schema ${schemaFile} does not exist (or did not load)`);
        continue;
      }
      const named = versionedName(schemaFile);
      if (versionOfFile(schemaFile) !== entry.version.slice(1)) {
        fail(fixture, `is listed for ${entry.version} but checked against ${schemaName}`);
        continue;
      }
      let payload;
      try {
        payload = read(fixture);
      } catch (error) {
        fail(fixture, error.message);
        continue;
      }
      const target = (file) =>
        `${schemas.get(file).$id}${entry.def === undefined ? "" : `#/$defs/${entry.def}`}`;
      let validate;
      try {
        validate = ajv.getSchema(target(schemaFile));
      } catch (error) {
        fail(fixture, `cannot check against ${target(schemaFile)}: ${error.message}`);
        continue;
      }
      if (validate === undefined) {
        fail(fixture, `${schemaName} has no definition "${entry.def}" under $defs`);
        continue;
      }
      const valid = validate(payload);
      if (entry.rule !== undefined) {
        // A named rule (T-011): the schema must take the fixture, so the rule alone accepts or refuses it.
        if (!rulesByContract.has(contractDir))
          rulesByContract.set(contractDir, loadRules(contractsDir, contractDir));
        const loaded = rulesByContract.get(contractDir);
        const rule = loaded.rules?.[entry.rule];
        if (typeof rule !== "function") {
          fail(
            fixture,
            `names the rule ${entry.rule}, which ${loaded.problem ?? `${contractDir}/${contractName}.rules.mjs does not export`}`,
          );
          continue;
        }
        if (!valid) {
          fail(
            fixture,
            `names the rule ${entry.rule}, so ${schemaName}${entry.def ? ` #/$defs/${entry.def}` : ""} must accept it and the rule alone decide it, but the schema refuses it:`,
          );
          for (const line of formatErrors(validate.errors)) errors.push(`  ${line}`);
          continue;
        }
        let problems;
        try {
          problems = rule(payload);
        } catch (error) {
          fail(fixture, `the rule ${entry.rule} failed to run: ${error.message}`);
          continue;
        }
        if (entry.expect === "refuse") {
          counts.refused += 1;
          counts.refusedByRule += 1;
          if (problems.length === 0) {
            fail(
              fixture,
              `must be refused by the rule ${entry.rule} (it shows: ${entry.shows}), but the rule passes it`,
            );
          }
          continue;
        }
        if (problems.length > 0) {
          fail(fixture, `must pass the rule ${entry.rule}, but:`);
          for (const line of problems) errors.push(`  ${line}`);
          continue;
        }
      }
      if (entry.expect === "accept") {
        counts.accepted += 1;
        if (!valid) {
          fail(
            fixture,
            `must be accepted by ${schemaName}${entry.def ? ` #/$defs/${entry.def}` : ""}, but is refused:`,
          );
          for (const line of formatErrors(validate.errors)) errors.push(`  ${line}`);
          continue;
        }
        // A minor version only adds: what an older version accepts, every later minor version accepts.
        if (named !== undefined) {
          for (const [laterFile] of schemas) {
            const later = versionedName(laterFile);
            if (
              posixDir(laterFile) !== contractDir ||
              later === undefined ||
              later.name !== named.name ||
              later.major !== named.major ||
              later.minor <= named.minor
            ) {
              continue;
            }
            let validateLater;
            try {
              validateLater = ajv.getSchema(target(laterFile));
            } catch {
              validateLater = undefined;
            }
            if (validateLater === undefined) {
              fail(
                fixture,
                `${baseName(laterFile)} drops ${entry.def ? `#/$defs/${entry.def}` : "its root"}; a minor version only adds`,
              );
            } else if (!validateLater(payload)) {
              fail(
                fixture,
                `is accepted by ${schemaName} but refused by ${baseName(laterFile)}; a minor version only adds:`,
              );
              for (const line of formatErrors(validateLater.errors)) errors.push(`  ${line}`);
            }
          }
        }
      } else {
        counts.refused += 1;
        if (valid) {
          fail(
            fixture,
            `must be refused by ${schemaName}${entry.def ? ` #/$defs/${entry.def}` : ""} (it shows: ${entry.shows}), but is accepted`,
          );
        }
      }
    }
    for (const file of files) {
      if (!file.startsWith(`${fixturesDir}/`) || file === indexFile || !file.endsWith(".json")) continue;
      const name = file.slice(fixturesDir.length + 1);
      if (!listed.has(name)) fail(file, `is not listed in ${indexFile}`);
    }
  }

  // 3. frozen.json: only in the two places the convention allows, in its shape, with a file for each frozen
  //    version (for a database part, its table list of that version in the part's own folder).
  const checkFrozen = metaValidator(FROZEN_META);
  for (const file of files.filter((name) => baseName(name) === "frozen.json")) {
    const folder = frozenFolder(file);
    if (folder === undefined) {
      fail(
        file,
        "a frozen.json sits only at contracts/<name>/frozen.json or contracts/db-schema/<part>/frozen.json " +
          "(the frozen-contract guard takes a file's nearest frozen.json)",
      );
      continue;
    }
    let data;
    try {
      data = read(file);
    } catch (error) {
      fail(file, error.message);
      continue;
    }
    if (checkFrozen !== undefined && !checkFrozen(data)) {
      for (const line of formatErrors(checkFrozen.errors)) fail(file, line);
      continue;
    }
    counts.frozen += 1;
    const versions = parseFrozen(JSON.stringify(data), file);
    if (folder.startsWith("db-schema/") && folder !== "db-schema/") {
      for (const version of versions) {
        const owned = files.some(
          (other) =>
            isTablesFile(other) && `${posixDir(other)}/` === folder && versionOfFile(other) === version,
        );
        if (!owned) fail(file, `freezes v${version}, but no table list of v${version} is in ${folder}`);
      }
      continue;
    }
    for (const version of versions) {
      const owned = files.some(
        (other) =>
          other.startsWith(folder) && !other.includes("/fixtures/") && versionOfFile(other) === version,
      );
      if (!owned)
        fail(file, `freezes v${version}, but no schema or tables file of v${version} is in ${folder}`);
    }
  }

  // 4. Table lists.
  const checkTables = metaValidator(TABLES_META);
  for (const file of files.filter(isTablesFile)) {
    let list;
    try {
      list = read(file);
    } catch (error) {
      fail(file, error.message);
      continue;
    }
    if (checkTables !== undefined && !checkTables(list)) {
      for (const line of formatErrors(checkTables.errors)) fail(file, line);
      continue;
    }
    counts.tableLists += 1;
    const named = versionedName(file);
    const folder = baseName(posixDir(file));
    if (named === undefined || named.name !== folder || list.part !== folder) {
      fail(
        file,
        `a table list is named <part>.v<N>.tables.json inside contracts/db-schema/<part>/, with "part": "<part>"`,
      );
    } else if (versionOfFile(file) !== list.version.slice(1)) {
      fail(file, `"version" is ${list.version}, but the file name says v${versionOfFile(file)}`);
    }
    for (const problem of tableProblems(list)) fail(file, problem);
  }

  return { errors, counts };
}

/** Columns that keys, constraints, indexes and flags name, but that the table does not have. */
export function tableProblems(list) {
  const problems = [];
  const tableNames = new Set();
  for (const table of list.tables) {
    const where = `table ${table.name}`;
    if (tableNames.has(table.name)) problems.push(`${where} is listed twice`);
    tableNames.add(table.name);
    const columns = new Set();
    for (const column of table.columns) {
      if (columns.has(column.name)) problems.push(`${where}: column ${column.name} is listed twice`);
      columns.add(column.name);
    }
    const need = (name, what) => {
      if (name !== undefined && !columns.has(name))
        problems.push(`${where}: ${what} names column ${name}, which the table does not have`);
    };
    for (const name of table.primaryKey) need(name, "the primary key");
    for (const key of table.foreignKeys ?? [])
      for (const name of key.columns) need(name, `foreign key ${key.name ?? ""}`.trim());
    for (const key of table.unique ?? [])
      for (const name of key.columns) need(name, `unique ${key.name ?? ""}`.trim());
    for (const rule of table.exclude ?? [])
      for (const element of rule.elements) need(element.column, `exclude ${rule.name}`);
    for (const index of table.indexes ?? [])
      for (const name of index.columns ?? []) need(name, `index ${index.name}`);
    if (table.rowLevelSecurity.scope === "business")
      need(table.rowLevelSecurity.column, "row-level security");
    need(table.versionColumn, "versionColumn");
    for (const name of table.effectiveColumns ?? []) need(name, "effectiveColumns");
    for (const column of table.columns) need(column.sealedBy, `column ${column.name}'s sealedBy`);
  }
  return problems;
}

/** Runs the check; returns the exit code. */
export function main(argv, { write = (line) => console.log(line) } = {}) {
  let contractsDir = CONTRACTS_DIR;
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--contracts" && argv[k + 1] !== undefined) {
      contractsDir = path.resolve(argv[k + 1]);
      k += 1;
    } else {
      write(`FAIL unknown argument "${argv[k]}". Usage: node scripts/check-fixtures.mjs [--contracts <dir>]`);
      return 1;
    }
  }
  if (!existsSync(contractsDir)) {
    write(`FAIL ${contractsDir} does not exist`);
    return 1;
  }
  const { errors, counts } = checkContracts(contractsDir);
  write(
    `contracts check: ${counts.schemas} schemas, ${counts.accepted} accepted and ${counts.refused} refused fixtures ` +
      `(${counts.refusedByRule} refused by a named rule), ` +
      `${counts.seedRows} seed rows left to their database test, ${counts.tableLists} table lists, ${counts.frozen} frozen.json`,
  );
  for (const line of errors) write(line.startsWith("  ") ? line : `FAIL ${line}`);
  if (errors.length === 0) {
    write("contracts check: passed");
    return 0;
  }
  const problems = errors.filter((line) => !line.startsWith("  ")).length;
  write(`contracts check: FAILED (${problems} problem${problems === 1 ? "" : "s"})`);
  return 1;
}

function runAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) process.exitCode = main(process.argv.slice(2));
