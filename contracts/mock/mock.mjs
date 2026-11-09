// The Tool API mock (C-186, T-510): page and console shells are built against it before the action layer exists
// (build prompt starting shape, M2 row: "page and console shells against a Tool API mock generated from the
// contract's fixtures"; 02-contracts section 2 item 9). ES module; Node's own modules only.
//
// It answers K-09's calls (contracts/tool-api/) and K-21's (contracts/page-api/) from tool-api-mock.json, which
// generate.mjs writes from the two contracts' accepted exchange fixtures and nobody edits by hand. A request that is
// a fixture's request (the same JSON, the order of its keys aside), in an environment the fixture's `given` names,
// gets a copy of that fixture's outcome, an error outcome included. Anything else throws ToolApiMockError naming the
// contract and the call: a contract or call no fixture shows, or a request no fixture holds, with the nearest
// fixture and where the request differs from it. The mock never makes up or defaults an answer, so a shell never
// leans on a call or a case no frozen fixture shows.
//
//   import { loadToolApiMock } from "../../contracts/mock/mock.mjs";
//   const mock = loadToolApiMock({ environment: "staging" });
//   const outcome = mock.answer("page-api", "openLink", request);
//
// `environment` is where the page runs, as K-21's given.environment: "staging" or "production". Each K-21 fixture
// names one, so a staging-only call answers stagingOnly in production only where a fixture shows it
// (fire-now-in-production.json); K-09's fixtures name none, so each holds in both.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The generated answers, beside this file (generate.mjs writes it). */
export const MOCK_FILE = fileURLToPath(new URL("./tool-api-mock.json", import.meta.url));

/** Where a page runs: K-21's given.environment. */
export const ENVIRONMENTS = Object.freeze(["staging", "production"]);

/** How many differences, and how many of a call's fixtures, a loud error lists. */
const MAX_SHOWN = 5;
const MAX_FIXTURES_SHOWN = 12;

/** A loud failure: no fixture answers this request, so the mock gives no answer. It is never an answer itself. */
export class ToolApiMockError extends Error {
  /**
   * @param {"unknownContract" | "unknownCall" | "noFixture"} code
   * @param {{ contract: unknown, call: unknown, environment: string }} where
   * @param {string} message
   */
  constructor(code, { contract, call, environment }, message) {
    super(`Tool API mock: ${message}`);
    this.name = "ToolApiMockError";
    this.code = code;
    this.contract = String(contract);
    this.call = String(call);
    this.environment = environment;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compare)
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/**
 * One text per JSON value, whatever the order of its keys: the value as JSON sends it, its keys sorted at every
 * depth. Two requests match when their texts are equal. Throws TypeError for a value JSON cannot send.
 */
export function canonicalJson(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError(`${typeof value} is not a JSON value`);
  return JSON.stringify(sortKeys(JSON.parse(text)));
}

const pointerPart = (key) => String(key).replaceAll("~", "~0").replaceAll("/", "~1");

/** The JSON pointers where `value` differs from `fixture`, at most `limit` of them. Both are plain JSON. */
function differences(value, fixture, at = "", found = [], limit = MAX_SHOWN + 1) {
  if (found.length >= limit) return found;
  const where = at === "" ? "/" : at;
  if (isObject(value) && isObject(fixture)) {
    const keys = [...new Set([...Object.keys(value), ...Object.keys(fixture)])].sort(compare);
    for (const key of keys) {
      if (found.length >= limit) break;
      const child = `${at}/${pointerPart(key)}`;
      if (!Object.hasOwn(fixture, key)) found.push(`${child} (not in the fixture)`);
      else if (!Object.hasOwn(value, key)) found.push(`${child} (missing)`);
      else differences(value[key], fixture[key], child, found, limit);
    }
  } else if (Array.isArray(value) && Array.isArray(fixture)) {
    if (value.length !== fixture.length) {
      found.push(`${where} (${value.length} items; the fixture has ${fixture.length})`);
    } else {
      for (let k = 0; k < value.length && found.length < limit; k += 1) {
        differences(value[k], fixture[k], `${at}/${k}`, found, limit);
      }
    }
  } else if (canonicalJson(value) !== canonicalJson(fixture)) {
    found.push(where);
  }
  return found;
}

const environmentFits = (answer, environment) =>
  answer.environment === null || answer.environment === environment;
const environmentsOverlap = (a, b) => a === null || b === null || a === b;
const named = (answer) => `${answer.fixture} (${answer.environment ?? "any environment"})`;

/** "v1", "v1 to v1.4". */
function versionSpan(versions) {
  if (versions.length === 0) return "no version";
  return versions.length === 1 ? versions[0] : `${versions[0]} to ${versions[versions.length - 1]}`;
}

/** The table's answers, checked and indexed by contract, call and canonical request. Throws TypeError if malformed. */
function readTable(table) {
  const fail = (why) => {
    throw new TypeError(`not a Tool API mock table (generate.mjs writes one): ${why}`);
  };
  if (!isObject(table) || !isObject(table.contracts)) fail("it has no contracts");
  const contracts = new Map();
  for (const [contract, part] of Object.entries(table.contracts)) {
    if (!isObject(part) || !Array.isArray(part.versions) || !isObject(part.calls)) {
      fail(`${contract} has no versions or no calls`);
    }
    const calls = new Map();
    for (const [call, listed] of Object.entries(part.calls)) {
      if (!Array.isArray(listed) || listed.length === 0) fail(`${contract} ${call} has no answers`);
      const answers = [];
      const byRequest = new Map();
      for (const given of listed) {
        const fits =
          isObject(given) &&
          typeof given.fixture === "string" &&
          (given.environment === null || ENVIRONMENTS.includes(given.environment)) &&
          Object.hasOwn(given, "request") &&
          Object.hasOwn(given, "outcome");
        if (!fits)
          fail(`${contract} ${call} has an answer without its fixture, environment, request or outcome`);
        // The mock's own copy, so a later change to the caller's table never changes an answer.
        const answer = {
          fixture: given.fixture,
          environment: given.environment,
          request: structuredClone(given.request),
          outcome: structuredClone(given.outcome),
        };
        answers.push(answer);
        const key = canonicalJson(answer.request);
        const same = byRequest.get(key) ?? [];
        for (const other of same) {
          if (
            environmentsOverlap(other.environment, answer.environment) &&
            canonicalJson(other.outcome) !== canonicalJson(answer.outcome)
          ) {
            fail(`${named(other)} and ${named(answer)} answer one ${contract} ${call} request differently`);
          }
        }
        same.push(answer);
        byRequest.set(key, same);
      }
      calls.set(call, { answers, byRequest });
    }
    contracts.set(contract, { versions: [...part.versions], calls });
  }
  return contracts;
}

/** The loud error's text for a request no fixture holds: the nearest fixture and where the request differs. */
function missMessage(contract, call, environment, known, request) {
  const head = `${contract} ${call} (${environment}): no fixture holds this request, so the mock gives no answer (it never makes one up).`;
  let nearest;
  for (const answer of known.answers) {
    const found = differences(request, answer.request);
    if (found.length === 0) {
      return `${head} ${named(answer)} holds it, but not for ${environment}.`;
    }
    if (nearest === undefined || found.length < nearest.found.length) nearest = { answer, found };
  }
  const shown = nearest.found.slice(0, MAX_SHOWN).join(", ");
  const more = nearest.found.length > MAX_SHOWN ? " and more" : "";
  const fixtures = known.answers.slice(0, MAX_FIXTURES_SHOWN).map(named).join(", ");
  const others =
    known.answers.length > MAX_FIXTURES_SHOWN ? ` and ${known.answers.length - MAX_FIXTURES_SHOWN} more` : "";
  return `${head} The nearest is ${named(nearest.answer)}, which differs at ${shown}${more}. Fixtures of ${call}: ${fixtures}${others}.`;
}

/**
 * A mock over one table (the parsed tool-api-mock.json), for pages that run in `environment`.
 * @param {unknown} table
 * @param {{ environment: "staging" | "production" }} options
 */
export function createToolApiMock(table, { environment } = {}) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new TypeError(
      `the Tool API mock runs in "staging" or "production" (K-21 given.environment), not ${JSON.stringify(environment)}`,
    );
  }
  const contracts = readTable(table);
  return Object.freeze({
    environment,
    /**
     * The outcome of the fixture whose request this is, as a copy; throws ToolApiMockError when there is none.
     * @param {string} contract "tool-api" (K-09) or "page-api" (K-21)
     * @param {string} call the call's name, as its fixtures' `call`
     * @param {unknown} request the call's request
     */
    answer(contract, call, request) {
      const where = { contract, call, environment };
      const part = contracts.get(contract);
      if (part === undefined) {
        const held = [...contracts.keys()].join(" and ");
        throw new ToolApiMockError(
          "unknownContract",
          where,
          `${String(contract)} ${String(call)}: there is no contract ${JSON.stringify(contract)} here; the mock answers ${held} only.`,
        );
      }
      const known = part.calls.get(call);
      if (known === undefined) {
        throw new ToolApiMockError(
          "unknownCall",
          where,
          `${contract} ${String(call)}: no fixture of ${contract} ${versionSpan(part.versions)} shows this call, so the mock has no answer for it. A call of a version frozen since needs the mock regenerated (npm run mock --workspace contracts).`,
        );
      }
      let key;
      try {
        key = canonicalJson(request);
      } catch (error) {
        throw new ToolApiMockError(
          "noFixture",
          where,
          `${contract} ${call} (${environment}): the request is not JSON (${error.message}), so no fixture holds it.`,
        );
      }
      const found = (known.byRequest.get(key) ?? []).find((answer) => environmentFits(answer, environment));
      if (found !== undefined) return structuredClone(found.outcome);
      throw new ToolApiMockError(
        "noFixture",
        where,
        missMessage(contract, call, environment, known, JSON.parse(JSON.stringify(request))),
      );
    },
  });
}

/**
 * The mock over the committed tool-api-mock.json (or another table file), for pages that run in `environment`.
 * @param {{ environment: "staging" | "production", file?: string }} options
 */
export function loadToolApiMock({ environment, file = MOCK_FILE } = {}) {
  return createToolApiMock(JSON.parse(readFileSync(file, "utf8")), { environment });
}
