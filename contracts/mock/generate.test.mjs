// Tests for the Tool API mock's generator (C-186, T-510), run by `npm run contracts:check` (the contracts workspace's
// check script runs `node --test` over scripts/*.test.mjs and mock/*.test.mjs). The repository's own files are only
// read; the generator's refusals are tried on throwaway contracts in the system temp folder.
//
// What they prove (the card's "Proves it with", with the lead's notes):
//   - regenerating from unchanged fixtures gives byte-identical output: the committed tool-api-mock.json is exactly
//     what generate.mjs writes from the versions it covers, so it was never edited by hand;
//   - the mock holds no response that is not in a fixture file: each answer is compared with the fixture it names,
//     and every accepted exchange of a covered version is held once;
//   - it covers frozen versions only, the first ones frozen, from v1 on;
//   - the generator takes every accepted exchange of a frozen version and nothing else, refuses a fixture its schema
//     refuses and two fixtures that answer one request differently, and --check tells a stale file.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { CONTRACTS_DIR, DIALECT, idFor, readJson } from "../scripts/lib.mjs";
import { MockGenerationError, buildMockTable, frozenVersions, generateMock, main } from "./generate.mjs";
import { MOCK_FILE } from "./mock.mjs";

const EXCHANGE = ".exchange";
const table = readJson(MOCK_FILE);
const coveredVersions = () =>
  Object.fromEntries(Object.entries(table.contracts).map(([contract, part]) => [contract, part.versions]));

/** Where two texts first differ, by line, for a readable failure. */
function firstDifference(expected, actual, [was, is] = ["the committed file has", "regenerating gives"]) {
  const want = expected.split("\n");
  const got = actual.split("\n");
  for (let k = 0; k < Math.max(want.length, got.length); k += 1) {
    if (want[k] !== got[k]) {
      return `line ${k + 1}: ${was} ${JSON.stringify(want[k])}, ${is} ${JSON.stringify(got[k])}`;
    }
  }
  return "the same lines";
}

describe("the generated mock, tool-api-mock.json", () => {
  it("regenerating from unchanged fixtures gives byte-identical output", async () => {
    const committed = readFileSync(MOCK_FILE);
    const first = await generateMock({ versions: coveredVersions() });
    assert.ok(
      Buffer.from(first.text, "utf8").equals(committed),
      `tool-api-mock.json is not what generate.mjs writes (never edit it by hand: npm run mock --workspace contracts): ${firstDifference(committed.toString("utf8"), first.text)}`,
    );
    const second = await generateMock({ versions: coveredVersions() });
    assert.ok(
      second.text === first.text,
      firstDifference(first.text, second.text, ["the first run gives", "the second gives"]),
    );
  });

  it("holds no response that is not in a fixture file: each answer is its fixture's, and each fixture is held once", () => {
    assert.deepEqual(Object.keys(table), ["about", "contracts"]);
    const problems = [];
    for (const [contract, part] of Object.entries(table.contracts)) {
      assert.deepEqual(Object.keys(part), ["versions", "calls"], contract);
      const index = readJson(path.join(CONTRACTS_DIR, contract, "fixtures", "index.json"));
      const held = new Map(); // fixture path -> times held
      for (const [call, answers] of Object.entries(part.calls)) {
        for (const answer of answers) {
          const where = `${contract} ${call} ${answer.fixture}`;
          assert.deepEqual(
            Object.keys(answer),
            ["fixture", "version", "environment", "request", "outcome"],
            where,
          );
          held.set(answer.fixture, (held.get(answer.fixture) ?? 0) + 1);
          const prefix = `${contract}/fixtures/`;
          const entry = index.fixtures.find((candidate) => `${prefix}${candidate.file}` === answer.fixture);
          if (!answer.fixture.startsWith(prefix) || entry === undefined) {
            problems.push(`${where}: no index entry names this fixture`);
            continue;
          }
          const payload = readJson(path.join(CONTRACTS_DIR, ...answer.fixture.split("/")));
          if (entry.expect !== "accept") problems.push(`${where}: a refused fixture`);
          if (entry.def !== `${call}${EXCHANGE}` || payload.call !== call)
            problems.push(`${where}: not ${call}'s exchange`);
          if (entry.version !== answer.version || !part.versions.includes(entry.version)) {
            problems.push(`${where}: version ${answer.version}, but the index says ${entry.version}`);
          }
          if ((payload.given?.environment ?? null) !== answer.environment)
            problems.push(`${where}: environment`);
          if (!isDeepStrictEqual(answer.request, payload.request))
            problems.push(`${where}: the request is not the fixture's`);
          if (!isDeepStrictEqual(answer.outcome, payload.outcome))
            problems.push(`${where}: the outcome is not the fixture's`);
        }
      }
      for (const entry of index.fixtures) {
        const wanted =
          entry.expect === "accept" && part.versions.includes(entry.version) && entry.def?.endsWith(EXCHANGE);
        const times = held.get(`${contract}/fixtures/${entry.file}`) ?? 0;
        if (wanted && times !== 1)
          problems.push(`${contract}/fixtures/${entry.file} is held ${times} times, not once`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("covers frozen versions only: the first ones frozen, from v1 on", () => {
    for (const [contract, part] of Object.entries(table.contracts)) {
      const frozen = frozenVersions(contract);
      assert.ok(part.versions.length > 0, contract);
      assert.deepEqual(
        part.versions,
        frozen.slice(0, part.versions.length),
        `${contract} covers ${part.versions}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The generator on throwaway contracts: each has one call, ping.

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rosie-mock-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, file, data) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), `${JSON.stringify(data, null, 2)}\n`);
}

/** ping's exchange as a fixture holds it; K-21's fixtures name their environment, K-09's none. */
const ping = (id, outcome, environment) => ({
  call: "ping",
  given: environment === undefined ? { note: "a test" } : { environment, note: "a test" },
  request: { id },
  outcome,
});

/** A contract with ping in each version listed, the versions frozen, and fixtures ({ file, payload, ...entry }). */
function writeContract(dir, contract, { versions = ["v1"], frozen = ["v1"], fixtures = [] } = {}) {
  for (const version of versions) {
    const file = `${contract}/${contract}.${version}.schema.json`;
    write(dir, file, {
      $schema: DIALECT,
      $id: idFor(file),
      $defs: {
        "ping.request": {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        "ping.exchange": {
          type: "object",
          properties: {
            // Any name, so the generator's own check that it is the index entry's call is what refuses another.
            call: { type: "string" },
            given: { type: "object" },
            request: { $ref: "#/$defs/ping.request" },
            outcome: { type: "object" },
          },
          required: ["call", "given", "request", "outcome"],
          additionalProperties: false,
        },
      },
    });
  }
  write(dir, `${contract}/frozen.json`, { frozen });
  const entries = fixtures.map((fixture) => {
    const entry = {
      version: "v1",
      def: "ping.exchange",
      expect: "accept",
      shows: "a test",
      source: "T-510 test",
      ...fixture,
    };
    delete entry.payload;
    return entry;
  });
  write(dir, `${contract}/fixtures/index.json`, { fixtures: entries });
  for (const { file, payload } of fixtures) write(dir, `${contract}/fixtures/${file}`, payload);
}

/** Both contracts the generator reads; `tool` and `page` are writeContract's options. */
function writeContracts(t, { tool = {}, page = {} } = {}) {
  const dir = tempDir(t);
  writeContract(dir, "tool-api", tool);
  writeContract(dir, "page-api", page);
  return dir;
}

function generationProblems(options) {
  try {
    buildMockTable(options);
  } catch (error) {
    assert.ok(error instanceof MockGenerationError, error.message);
    return error.problems.join("\n");
  }
  return "";
}

describe("the generator", () => {
  it("takes every accepted exchange of a frozen version, and nothing else", (t) => {
    const dir = writeContracts(t, {
      tool: {
        versions: ["v1", "v1.1"],
        frozen: ["v1"],
        fixtures: [
          { file: "taken.json", payload: ping("a", { pong: "a" }) },
          { file: "invalid/refused.json", expect: "refuse", payload: ping(1, { pong: "refused" }) },
          { file: "not-frozen.json", version: "v1.1", payload: ping("b", { pong: "v1.1" }) },
          { file: "not-an-exchange.json", def: "ping.request", payload: { id: "c" } },
        ],
      },
      page: { fixtures: [{ file: "page.json", payload: ping("a", { shown: true }, "staging") }] },
    });
    const built = buildMockTable({ contractsDir: dir });
    assert.deepEqual(Object.keys(built.contracts), ["page-api", "tool-api"]);
    assert.deepEqual(built.contracts["tool-api"], {
      versions: ["v1"],
      calls: {
        ping: [
          {
            fixture: "tool-api/fixtures/taken.json",
            version: "v1",
            environment: null,
            request: { id: "a" },
            outcome: { pong: "a" },
          },
        ],
      },
    });
    assert.deepEqual(built.contracts["page-api"].calls.ping, [
      {
        fixture: "page-api/fixtures/page.json",
        version: "v1",
        environment: "staging",
        request: { id: "a" },
        outcome: { shown: true },
      },
    ]);
    assert.deepEqual(buildMockTable({ contractsDir: dir, versions: { "tool-api": ["v1"] } }), built);
  });

  it("refuses two fixtures that answer one request differently in one environment; two environments may differ", (t) => {
    const twoEnvironments = [
      { file: "staging.json", payload: ping("same", { fired: true }, "staging") },
      { file: "production.json", payload: ping("same", { error: "stagingOnly" }, "production") },
    ];
    const fine = writeContracts(t, { page: { fixtures: twoEnvironments } });
    const calls = buildMockTable({ contractsDir: fine }).contracts["page-api"].calls;
    assert.deepEqual(
      calls.ping.map((answer) => [answer.fixture, answer.environment]),
      [
        ["page-api/fixtures/production.json", "production"],
        ["page-api/fixtures/staging.json", "staging"],
      ],
    );

    const sameEnvironment = writeContracts(t, {
      page: {
        fixtures: [
          ...twoEnvironments,
          { file: "other.json", payload: ping("same", { fired: false }, "staging") },
        ],
      },
    });
    assert.match(
      generationProblems({ contractsDir: sameEnvironment }),
      /page-api\/fixtures\/other\.json and page-api\/fixtures\/staging\.json answer one page-api ping request in staging differently/,
    );

    const anyEnvironment = writeContracts(t, {
      tool: {
        fixtures: [
          { file: "one.json", payload: ping("same", { n: 1 }) },
          { file: "two.json", payload: ping("same", { n: 2 }) },
        ],
      },
    });
    assert.match(
      generationProblems({ contractsDir: anyEnvironment }),
      /one\.json and tool-api\/fixtures\/two\.json/,
    );

    const sameAnswer = writeContracts(t, {
      tool: {
        fixtures: [
          { file: "one.json", payload: ping("same", { n: 1 }) },
          { file: "two.json", payload: ping("same", { n: 1 }) },
        ],
      },
    });
    assert.equal(buildMockTable({ contractsDir: sameAnswer }).contracts["tool-api"].calls.ping.length, 2);
  });

  it("refuses a fixture its schema refuses, a call its index entry does not name, and a version not frozen", (t) => {
    const dir = writeContracts(t, {
      tool: {
        fixtures: [
          { file: "bad-request.json", payload: ping(7, { pong: "a" }) },
          { file: "wrong-call.json", payload: { ...ping("a", {}), call: "pong" } },
        ],
      },
    });
    const problems = generationProblems({ contractsDir: dir });
    assert.match(
      problems,
      /tool-api\/fixtures\/bad-request\.json: tool-api\/tool-api\.v1\.schema\.json #\/\$defs\/ping\.exchange refuses it/,
    );
    assert.match(problems, /\/request\/id must be string/);
    assert.match(problems, /wrong-call\.json: its call is "pong", but its index entry names ping\.exchange/);
    assert.match(
      generationProblems({ contractsDir: writeContracts(t), versions: { "tool-api": ["v1", "v1.1"] } }),
      /tool-api v1\.1 is not frozen/,
    );
  });

  it("writes the file; --check passes on it and fails on a hand edit or a version frozen since", async (t) => {
    const dir = writeContracts(t, {
      tool: { versions: ["v1", "v1.1"], fixtures: [{ file: "a.json", payload: ping("a", { pong: "a" }) }] },
      page: { fixtures: [{ file: "p.json", payload: ping("p", { shown: true }, "staging") }] },
    });
    const out = path.join(tempDir(t), "tool-api-mock.json");
    const lines = [];
    const run = (...argv) =>
      main(["--contracts", dir, "--out", out, ...argv], { write: (line) => lines.push(line) });

    assert.equal(await run(), 0, lines.join("\n"));
    const written = readFileSync(out, "utf8");
    assert.deepEqual(JSON.parse(written).contracts["tool-api"].versions, ["v1"]);
    assert.equal(await run("--check"), 0, lines.join("\n"));
    assert.equal(readFileSync(out, "utf8"), written, "--check writes nothing");

    writeFileSync(out, written.replace('"pong": "a"', '"pong": "edited by hand"'));
    assert.equal(await run("--check"), 1);
    assert.match(lines.at(-1), /never edit it by hand/);
    writeFileSync(out, written);
    assert.equal(await run("--check"), 0);

    write(dir, "tool-api/frozen.json", { frozen: ["v1", "v1.1"] });
    assert.equal(await run("--check"), 1);
    assert.match(lines.at(-1), /it covers page-api v1; tool-api v1\./);
    assert.equal(await run(), 0);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).contracts["tool-api"].versions, ["v1", "v1.1"]);

    assert.equal(await run("--nonsense"), 1);
    assert.match(lines.at(-1), /unknown argument/);
  });
});
