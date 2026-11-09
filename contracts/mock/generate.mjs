#!/usr/bin/env node
// The Tool API mock's generator (C-186, T-510): `npm run mock --workspace contracts` writes contracts/mock/
// tool-api-mock.json, the answers mock.mjs gives (02-contracts section 2 item 9: "generated from the fixtures of K-09
// and K-21"). ES module; uses ajv through scripts/lib.mjs, the contracts workspace's one validator (item 8), and
// prettier, both from the root manifest.
//
// What it reads: for K-09 (contracts/tool-api/) and K-21 (contracts/page-api/), every fixtures/index.json entry that
// is accepted, of a version the contract's frozen.json freezes, and whose `def` is a call's exchange
// (<call>.exchange: one request and its outcome, which is what the Tool API mock answers from: each schema's own
// description). Each one is checked first against that definition in its version's schema, and by the named rule
// its entry gives (scripts/check-fixtures.mjs's hook), as `npm run contracts:check` checks it, so the mock holds no
// answer its contract refuses. Refused fixtures, versions not frozen, and accepted fixtures that are not a call's
// exchange (K-21's pageWordsSwap: the page entry's own swap, not a call's answer) give no answer.
//
// What it writes: for each contract, the versions it covers and, for each call (sorted by name), each fixture
// (sorted by path) with its version, the environment its `given` names (K-21; null for K-09, whose fixtures name
// none and hold in both), its request and its outcome, word for word. It refuses to write when two fixtures answer
// one request of one call in one environment differently, since the mock would have to pick one. The text is
// formatted with the repository's Prettier settings, so the same fixtures always give the same bytes and
// `npm run format:check` passes it.
//
// The file is generated, never edited by hand. When a minor version of K-09 or K-21 is frozen with new fixtures, run
// the script again and commit the result; until then the mock answers the versions it covers and fails loudly on the
// rest. generate.test.mjs regenerates the file from the versions it covers and fails unless every byte matches, so
// `npm run contracts:check` fails a hand edit, while a version frozen since fails only --check below.
//
// Usage: node mock/generate.mjs [--check] [--contracts <dir>] [--out <file>]
//   (no flag)  write the file from every frozen version of both contracts;
//   --check    write nothing; fail when the file is not what the script writes now (a hand edit, or a version
//              frozen since it was generated).
// Exit code: 0 written or up to date, 1 failed or out of date.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as prettier from "prettier";

import { parseFrozen } from "../../infra/ci/contract-freeze-guard.mjs";
import { loadRules } from "../scripts/check-fixtures.mjs";
import {
  CONTRACTS_DIR,
  createAjv,
  formatErrors,
  isSchemaFile,
  listFiles,
  readJson,
} from "../scripts/lib.mjs";
import { MOCK_FILE, canonicalJson } from "./mock.mjs";

/** The contracts the mock answers, in the file's order: K-21's page and console calls, then K-09's Tool API. */
export const MOCKED_CONTRACTS = Object.freeze(["page-api", "tool-api"]);

const EXCHANGE = ".exchange";
const ABOUT =
  "The Tool API mock's answers (C-186, T-510): for each call of K-21 (page-api) and K-09 (tool-api), each accepted " +
  "exchange fixture of the frozen versions named here, with its request and its outcome word for word. Generated " +
  "by contracts/mock/generate.mjs; never edit it by hand. When a minor version is frozen with new fixtures, run " +
  "npm run mock --workspace contracts and commit the result.";
const USAGE = "Usage: node mock/generate.mjs [--check] [--contracts <dir>] [--out <file>]";

/** The mock was not generated; `problems` holds one line per reason. */
export class MockGenerationError extends Error {
  constructor(problems) {
    super(`the Tool API mock was not generated:\n${problems.map((line) => `  ${line}`).join("\n")}`);
    this.name = "MockGenerationError";
    this.problems = problems;
  }
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** "v1.2" -> [1, 2], "v1" -> [1, 0]. */
function placeOf(version) {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null)
    throw new MockGenerationError([`"${version}" is not a contract version (v1, v1.1, ...)`]);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/** Oldest first. */
export function byVersion(a, b) {
  const [majorA, minorA] = placeOf(a);
  const [majorB, minorB] = placeOf(b);
  return majorA - majorB || minorA - minorB;
}

/** The versions contracts/<contract>/frozen.json freezes, oldest first ("v1", "v1.1", ...). */
export function frozenVersions(contract, contractsDir = CONTRACTS_DIR) {
  const file = `${contract}/frozen.json`;
  let text;
  try {
    text = readFileSync(path.join(contractsDir, contract, "frozen.json"), "utf8");
  } catch {
    throw new MockGenerationError([`${file} is missing: the mock answers frozen versions only`]);
  }
  return [...parseFrozen(text, file)].map((version) => `v${version}`).sort(byVersion);
}

/**
 * The mock's table: per contract, the versions it covers and, per call, each answer. Throws MockGenerationError
 * listing every problem.
 * @param {{ contractsDir?: string, contracts?: readonly string[], versions?: Record<string, string[]> }} options
 *   versions: per contract, the frozen versions to cover; every frozen version where it names none.
 */
export function buildMockTable({
  contractsDir = CONTRACTS_DIR,
  contracts = MOCKED_CONTRACTS,
  versions = {},
} = {}) {
  const problems = [];
  const read = (file) => readJson(path.join(contractsDir, ...file.split("/")), file);

  // The schemas, all of them first: an exchange reaches other contracts' files by $ref.
  const ajv = createAjv();
  const schemaIds = new Map(); // contracts-relative file -> $id
  for (const file of listFiles(contractsDir).filter(isSchemaFile)) {
    try {
      const schema = read(file);
      ajv.addSchema(schema);
      schemaIds.set(file, schema.$id);
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
  }

  const table = { about: ABOUT, contracts: {} };
  for (const contract of contracts) {
    let frozen;
    let index;
    try {
      frozen = frozenVersions(contract, contractsDir);
      index = read(`${contract}/fixtures/index.json`);
    } catch (error) {
      problems.push(...(error instanceof MockGenerationError ? error.problems : [error.message]));
      continue;
    }
    const covered = [...(versions[contract] ?? frozen)].sort(byVersion);
    for (const version of covered) {
      if (!frozen.includes(version)) {
        problems.push(
          `${contract} ${version} is not frozen (${contract}/frozen.json): the mock answers frozen versions only`,
        );
      }
    }
    let rules;
    const answers = new Map(); // call -> answers
    for (const entry of index.fixtures ?? []) {
      const exchange = typeof entry.def === "string" && entry.def.endsWith(EXCHANGE);
      if (entry.expect !== "accept" || !covered.includes(entry.version) || !exchange) continue;
      const call = entry.def.slice(0, -EXCHANGE.length);
      const fixture = `${contract}/fixtures/${entry.file}`;
      const schemaFile = `${contract}/${entry.schema ?? `${contract}.${entry.version}.schema.json`}`;
      let payload;
      try {
        payload = read(fixture);
      } catch (error) {
        problems.push(`${fixture}: ${error.message}`);
        continue;
      }
      const id = schemaIds.get(schemaFile);
      let validate;
      try {
        validate = id === undefined ? undefined : ajv.getSchema(`${id}#/$defs/${entry.def}`);
      } catch (error) {
        problems.push(`${fixture}: ${schemaFile} #/$defs/${entry.def} does not compile: ${error.message}`);
        continue;
      }
      if (validate === undefined) {
        problems.push(`${fixture}: ${schemaFile} has no definition ${entry.def} to check it against`);
        continue;
      }
      if (!validate(payload)) {
        problems.push(`${fixture}: ${schemaFile} #/$defs/${entry.def} refuses it:`);
        problems.push(...formatErrors(validate.errors).map((line) => `  ${line}`));
        continue;
      }
      if (entry.rule !== undefined) {
        rules ??= loadRules(contractsDir, contract);
        const rule = rules.rules?.[entry.rule];
        let broken;
        try {
          broken =
            typeof rule === "function"
              ? rule(payload)
              : [`it is not exported (${rules.problem ?? `${contract}/${contract}.rules.mjs`})`];
        } catch (error) {
          broken = [`it failed to run: ${error.message}`];
        }
        if (broken.length > 0) {
          problems.push(
            `${fixture}: the rule ${entry.rule} refuses it:`,
            ...broken.map((line) => `  ${line}`),
          );
          continue;
        }
      }
      if (payload.call !== call) {
        problems.push(
          `${fixture}: its call is ${JSON.stringify(payload.call)}, but its index entry names ${entry.def}`,
        );
        continue;
      }
      const list = answers.get(call) ?? [];
      list.push({
        fixture,
        version: entry.version,
        environment: payload.given?.environment ?? null,
        request: payload.request,
        outcome: payload.outcome,
      });
      answers.set(call, list);
    }

    const calls = [];
    for (const call of [...answers.keys()].sort(compare)) {
      const list = answers.get(call).sort((a, b) => compare(a.fixture, b.fixture));
      const byRequest = new Map();
      for (const answer of list) {
        const key = canonicalJson(answer.request);
        for (const other of byRequest.get(key) ?? []) {
          const overlap =
            other.environment === null ||
            answer.environment === null ||
            other.environment === answer.environment;
          if (overlap && canonicalJson(other.outcome) !== canonicalJson(answer.outcome)) {
            const where = answer.environment === null ? "" : ` in ${answer.environment}`;
            problems.push(
              `${other.fixture} and ${answer.fixture} answer one ${contract} ${call} request${where} differently, so the mock would have to pick one`,
            );
          }
        }
        byRequest.set(key, [...(byRequest.get(key) ?? []), answer]);
      }
      calls.push([call, list]);
    }
    // Own keys whatever a call is named (Object.fromEntries never sets a prototype), in the sorted order.
    table.contracts[contract] = { versions: covered, calls: Object.fromEntries(calls) };
  }
  if (problems.length > 0) throw new MockGenerationError(problems);
  return table;
}

/** The table as the file holds it: JSON, formatted as `npm run format:check` wants the committed file. */
export async function formatMockTable(table) {
  const options = (await prettier.resolveConfig(MOCK_FILE, { editorconfig: true })) ?? {};
  return prettier.format(JSON.stringify(table, null, 2), { ...options, filepath: MOCK_FILE });
}

/**
 * Builds the table and its text (see buildMockTable for the options).
 * @returns {Promise<{ table: object, text: string }>}
 */
export async function generateMock(options = {}) {
  const table = buildMockTable(options);
  return { table, text: await formatMockTable(table) };
}

/** "page-api v1 to v1.2: 120 answers to 44 calls; tool-api ...". */
function summary(table) {
  return Object.entries(table.contracts)
    .map(([contract, part]) => {
      const lists = Object.values(part.calls);
      const answers = lists.reduce((sum, list) => sum + list.length, 0);
      const span =
        part.versions.length === 1 ? part.versions[0] : `${part.versions[0]} to ${part.versions.at(-1)}`;
      return `${contract} ${span}: ${answers} answers to ${lists.length} calls`;
    })
    .join("; ");
}

/** What the file on disk covers, for --check's message; null when it cannot be read. */
function coveredBy(file) {
  try {
    const held = JSON.parse(readFileSync(file, "utf8"));
    return Object.entries(held.contracts)
      .map(([contract, part]) => `${contract} ${part.versions.join(", ")}`)
      .join("; ");
  } catch {
    return null;
  }
}

/** Runs the generator; resolves to the exit code. */
export async function main(argv, { write = (line) => console.log(line) } = {}) {
  let contractsDir = CONTRACTS_DIR;
  let out = MOCK_FILE;
  let check = false;
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--check") {
      check = true;
    } else if ((argv[k] === "--contracts" || argv[k] === "--out") && argv[k + 1] !== undefined) {
      if (argv[k] === "--contracts") contractsDir = path.resolve(argv[k + 1]);
      else out = path.resolve(argv[k + 1]);
      k += 1;
    } else {
      write(`FAIL unknown argument "${argv[k]}". ${USAGE}`);
      return 1;
    }
  }
  const shown = path.relative(process.cwd(), out) || out;
  let generated;
  try {
    generated = await generateMock({ contractsDir });
  } catch (error) {
    write(`FAIL ${error.message}`);
    return 1;
  }
  if (!check) {
    writeFileSync(out, generated.text);
    write(`tool-api mock: wrote ${shown} (${summary(generated.table)})`);
    return 0;
  }
  let current = null;
  try {
    current = readFileSync(out, "utf8");
  } catch {
    // reported below
  }
  if (current === generated.text) {
    write(`tool-api mock: ${shown} is up to date (${summary(generated.table)})`);
    return 0;
  }
  const held = coveredBy(out);
  write(
    `FAIL tool-api mock: ${shown} is not what generate.mjs writes now from the frozen fixtures (${summary(generated.table)})` +
      `${held === null ? "; it is missing or not JSON" : `; it covers ${held}`}. Run npm run mock --workspace contracts ` +
      "and commit the result; never edit it by hand.",
  );
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

if (runAsScript()) process.exitCode = await main(process.argv.slice(2));
