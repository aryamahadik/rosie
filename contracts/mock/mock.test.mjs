// Tests for the Tool API mock's answers (C-186, T-510), run by `npm run contracts:check` (the contracts workspace's
// check script runs `node --test` over scripts/*.test.mjs and mock/*.test.mjs). They read the committed
// tool-api-mock.json and the fixtures of K-09 (tool-api) and K-21 (page-api); nothing in contracts/ is changed.
//
// What they prove (the card's "Proves it with", with the lead's notes):
//   - every accepted fixture of the versions the mock covers: its request gets its outcome, in each environment its
//     `given` names (both for K-09, whose fixtures name none);
//   - a request no fixture holds, a call no fixture shows, a contract the mock does not hold, and a fixture's request
//     in an environment its `given` does not name: a loud ToolApiMockError naming the call, never a default answer;
//   - refuse-fire-now-in-production.json's and refuse-link-as-proof.json's requests get the refusal each fixture
//     states (its accepted twin's answer, which its note names). Every other refused fixture fails loudly, except
//     where its request is an accepted twin's: then it gets the twin's answer, never a refused outcome. That is the
//     refused outcome's place taken by the right one, or, for a fixture refused only for what its `given` states (the
//     step a named rule checks, never sent), the same answer the call gives that request.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { CONTRACTS_DIR, readJson } from "../scripts/lib.mjs";
import {
  ENVIRONMENTS,
  MOCK_FILE,
  ToolApiMockError,
  canonicalJson,
  createToolApiMock,
  loadToolApiMock,
} from "./mock.mjs";

const EXCHANGE = ".exchange";
const table = readJson(MOCK_FILE);
const mocks = Object.fromEntries(
  ENVIRONMENTS.map((environment) => [environment, loadToolApiMock({ environment })]),
);
const CONTRACTS = Object.keys(table.contracts);

/** Each index entry of the versions the mock covers, with its fixture's path and payload. */
function coveredEntries(contract) {
  const covered = new Set(table.contracts[contract].versions);
  const index = readJson(path.join(CONTRACTS_DIR, contract, "fixtures", "index.json"));
  return index.fixtures
    .filter((entry) => covered.has(entry.version))
    .map((entry) => ({
      ...entry,
      contract,
      path: `${contract}/fixtures/${entry.file}`,
      payload: readJson(path.join(CONTRACTS_DIR, contract, "fixtures", ...entry.file.split("/"))),
    }));
}
const entries = CONTRACTS.flatMap(coveredEntries);
const isExchange = (entry) => entry.def?.endsWith(EXCHANGE) === true;
const callOf = (entry) => entry.def.slice(0, -EXCHANGE.length);
const accepted = entries.filter((entry) => entry.expect === "accept");
const acceptedExchanges = accepted.filter(isExchange);
const refused = entries.filter((entry) => entry.expect === "refuse");
const entryAt = (fixturePath) => {
  const found = entries.find((entry) => entry.path === fixturePath);
  assert.ok(found !== undefined, `${fixturePath} is an entry of a version the mock covers`);
  return found;
};

/** The environments an exchange's given names: its own, or both when it names none (K-09). */
const environmentsOf = (payload) =>
  payload.given?.environment === undefined ? ENVIRONMENTS : [payload.given.environment];

/** The mock's answer, or the ToolApiMockError it throws (any other error fails the test). */
function ask(environment, contract, call, request) {
  try {
    return { answer: mocks[environment].answer(contract, call, request) };
  } catch (error) {
    if (!(error instanceof ToolApiMockError)) throw error;
    return { error };
  }
}

/** Asserts a loud error: a ToolApiMockError with this code, whose message names the contract and the call. */
function assertLoud(result, code, contract, call, what) {
  assert.ok(
    result.error !== undefined,
    `${what}: expected a loud error, got ${JSON.stringify(result.answer)}`,
  );
  assert.equal(result.error.code, code, `${what}: ${result.error.message}`);
  assert.equal(result.error.contract, contract, what);
  assert.equal(result.error.call, call, what);
  assert.ok(result.error.message.includes(`${contract} ${call}`), `${what}: ${result.error.message}`);
}

/** A copy of a JSON value with its first string leaf (keys in order) changed, or a key added if it has none. */
function withOneLeafChanged(request) {
  const copy = structuredClone(request);
  const change = (node) => {
    if (Array.isArray(node) || (node !== null && typeof node === "object")) {
      for (const key of Object.keys(node)) {
        if (typeof node[key] === "string") {
          node[key] = `${node[key]}-not-a-fixture`;
          return true;
        }
        if (change(node[key])) return true;
      }
    }
    return false;
  };
  if (!change(copy)) copy.notAFixture = true;
  return copy;
}

describe("the Tool API mock answers every accepted fixture", () => {
  it("covers K-21 and K-09, each from v1 on", () => {
    assert.deepEqual(CONTRACTS, ["page-api", "tool-api"]);
    for (const contract of CONTRACTS) assert.equal(table.contracts[contract].versions[0], "v1", contract);
    assert.ok(acceptedExchanges.length > 200, `${acceptedExchanges.length} accepted exchanges`);
  });

  it("gives each accepted exchange's outcome for its request, in each environment its given names", () => {
    const problems = [];
    for (const entry of acceptedExchanges) {
      for (const environment of environmentsOf(entry.payload)) {
        const result = ask(environment, entry.contract, callOf(entry), entry.payload.request);
        if (result.error !== undefined)
          problems.push(`${entry.path} (${environment}): ${result.error.message}`);
        else if (!isDeepStrictEqual(result.answer, entry.payload.outcome)) {
          problems.push(`${entry.path} (${environment}): answered ${JSON.stringify(result.answer)}`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("answers the same request whatever the order of its keys", () => {
    const reverse = (value) => {
      if (Array.isArray(value)) return value.map(reverse);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.keys(value)
          .reverse()
          .map((key) => [key, reverse(value[key])]),
      );
    };
    for (const entry of acceptedExchanges) {
      const [environment] = environmentsOf(entry.payload);
      const answer = mocks[environment].answer(entry.contract, callOf(entry), reverse(entry.payload.request));
      assert.deepEqual(answer, entry.payload.outcome, entry.path);
    }
  });

  it("holds no answer for an accepted fixture that is not a call's exchange: it has no request or outcome", () => {
    const others = accepted.filter((entry) => !isExchange(entry));
    for (const entry of others) {
      assert.ok(!Object.hasOwn(entry.payload, "request"), `${entry.path} has a request`);
      assert.ok(!Object.hasOwn(entry.payload, "outcome"), `${entry.path} has an outcome`);
      assert.ok(
        !Object.hasOwn(table.contracts[entry.contract].calls, entry.def),
        `${entry.path}: ${entry.def}`,
      );
    }
  });

  it("returns a copy: changing an answer does not change the next one", () => {
    const entry = entryAt("page-api/fixtures/fire-now.json");
    const first = mocks.staging.answer("page-api", "fireNow", entry.payload.request);
    first.result = "changed";
    first.written.written.length = 0;
    assert.deepEqual(
      mocks.staging.answer("page-api", "fireNow", entry.payload.request),
      entry.payload.outcome,
    );
  });

  it("keeps its own copy of the table: changing the table afterwards changes no answer", () => {
    const entry = entryAt("page-api/fixtures/fire-now.json");
    const copy = structuredClone(table);
    const mock = createToolApiMock(copy, { environment: "staging" });
    const held = copy.contracts["page-api"].calls.fireNow.find((answer) => answer.environment === "staging");
    held.outcome.result = "changed";
    held.request.clockRowId = "changed";
    assert.deepEqual(mock.answer("page-api", "fireNow", entry.payload.request), entry.payload.outcome);
  });

  it("gives an error outcome as an answer, as the fixture holds it, and throws only when no fixture answers", () => {
    const entry = entryAt("tool-api/fixtures/booking-paused.json");
    for (const environment of ENVIRONMENTS) {
      assert.deepEqual(mocks[environment].answer("tool-api", "issueChatLink", entry.payload.request), {
        error: "bookingPaused",
        retryAfterSeconds: 60,
      });
    }
  });
});

describe("the mock fails loudly on any other request, naming the call", () => {
  it("throws for each accepted exchange's request with one field changed, or one field added", () => {
    for (const entry of acceptedExchanges) {
      const call = callOf(entry);
      for (const environment of environmentsOf(entry.payload)) {
        const changed = withOneLeafChanged(entry.payload.request);
        assertLoud(
          ask(environment, entry.contract, call, changed),
          "noFixture",
          entry.contract,
          call,
          entry.path,
        );
        const added = { ...entry.payload.request, notAFixture: true };
        assertLoud(
          ask(environment, entry.contract, call, added),
          "noFixture",
          entry.contract,
          call,
          entry.path,
        );
      }
    }
  });

  it("names the nearest fixture and where the request differs from it", () => {
    const entry = entryAt("page-api/fixtures/open-link-secure-page.json");
    const request = structuredClone(entry.payload.request);
    request.page.requestId = "req-not-in-any-fixture";
    const result = ask("staging", "page-api", "openLink", request);
    assertLoud(result, "noFixture", "page-api", "openLink", "openLink with a new requestId");
    assert.match(result.error.message, /never makes one up/);
    assert.match(
      result.error.message,
      /page-api\/fixtures\/open-link-secure-page\.json \(staging\), which differs at \/page\/requestId/,
    );
  });

  it("throws for a fixture's request in an environment its given does not name, never a default answer", () => {
    const problems = [];
    for (const entry of acceptedExchanges.filter(
      (candidate) => candidate.payload.given?.environment !== undefined,
    )) {
      const call = callOf(entry);
      const other = ENVIRONMENTS.find((environment) => environment !== entry.payload.given.environment);
      const twin = acceptedExchanges.find(
        (candidate) =>
          candidate.contract === entry.contract &&
          callOf(candidate) === call &&
          candidate.payload.given?.environment === other &&
          canonicalJson(candidate.payload.request) === canonicalJson(entry.payload.request),
      );
      const result = ask(other, entry.contract, call, entry.payload.request);
      if (twin !== undefined) {
        if (!isDeepStrictEqual(result.answer, twin.payload.outcome))
          problems.push(`${entry.path} in ${other}`);
      } else if (
        result.error?.code !== "noFixture" ||
        !result.error.message.includes(`holds it, but not for ${other}`)
      ) {
        problems.push(`${entry.path} in ${other}: ${JSON.stringify(result.answer ?? result.error?.message)}`);
      }
    }
    assert.deepEqual(problems, []);
    // The staging test roster has no production fixture, so production gets no answer at all, not stagingOnly.
    const roster = entryAt("page-api/fixtures/test-roster.json");
    assertLoud(
      ask("production", "page-api", "testRoster", roster.payload.request),
      "noFixture",
      "page-api",
      "testRoster",
      "roster",
    );
  });

  it("throws for a call no fixture shows, and for a K-21 call asked of K-09", () => {
    const request = entryAt("page-api/fixtures/fire-now.json").payload.request;
    assertLoud(
      ask("staging", "page-api", "noSuchCall", request),
      "unknownCall",
      "page-api",
      "noSuchCall",
      "page-api",
    );
    assertLoud(
      ask("staging", "tool-api", "fireNow", request),
      "unknownCall",
      "tool-api",
      "fireNow",
      "fireNow in tool-api",
    );
    assert.match(ask("staging", "tool-api", "fireNow", request).error.message, /regenerated/);
  });

  it("throws for a contract the mock does not hold", () => {
    const result = ask("staging", "agent-api", "find", {});
    assertLoud(result, "unknownContract", "agent-api", "find", "agent-api");
  });

  it("throws for requests that are no fixture's: nothing, null, an empty object, a list, a string, a value JSON cannot send", () => {
    for (const request of [undefined, null, {}, [], "openLink", 1n]) {
      assertLoud(
        ask("staging", "page-api", "openLink", request),
        "noFixture",
        "page-api",
        "openLink",
        String(request),
      );
    }
  });

  it("refuses an environment other than staging or production, and a table that is not the generator's", () => {
    assert.throws(() => createToolApiMock(table, { environment: "test" }), TypeError);
    assert.throws(() => createToolApiMock(table, {}), TypeError);
    assert.throws(() => createToolApiMock({}, { environment: "staging" }), TypeError);
  });

  it("refuses a table where two fixtures answer one request differently: it never picks one", () => {
    const copy = structuredClone(table);
    const answers = copy.contracts["page-api"].calls.fireNow;
    const staging = answers.find((answer) => answer.environment === "staging");
    answers.push({
      ...structuredClone(staging),
      fixture: "page-api/fixtures/made-up.json",
      outcome: { error: "stagingOnly" },
    });
    assert.throws(
      () => createToolApiMock(copy, { environment: "staging" }),
      /answer one page-api fireNow request differently/,
    );
  });
});

describe("refused fixtures fail loudly, or their request gets the refusal they state, never a refused outcome", () => {
  /** A refused fixture's own statement: its accepted twin, named in its note, whose answer is the refusal. */
  const STATED = [
    {
      refused: "page-api/fixtures/invalid/refuse-fire-now-in-production.json",
      twin: "page-api/fixtures/fire-now-in-production.json",
      call: "fireNow",
      check: (answer) => assert.deepEqual(answer, { error: "stagingOnly" }),
    },
    {
      refused: "page-api/fixtures/invalid/refuse-link-as-proof.json",
      twin: "page-api/fixtures/open-link-secure-page.json",
      call: "openLink",
      check: (answer) => {
        assert.equal(answer.proof, "none");
        assert.equal(answer.acting, null);
        assert.equal(answer.securePageOnly, false);
        assert.deepEqual(answer.signIn, { ways: ["text", "email"] });
      },
    },
  ];

  for (const stated of STATED) {
    it(`${path.posix.basename(stated.refused)}'s request gets the refusal it states: ${path.posix.basename(stated.twin)}'s answer`, () => {
      const entry = entryAt(stated.refused);
      const twin = entryAt(stated.twin);
      assert.equal(entry.expect, "refuse");
      assert.equal(entry.def, `${stated.call}${EXCHANGE}`);
      assert.ok(
        entry.payload.given.note.includes(path.posix.basename(stated.twin)),
        "the refused fixture names its twin",
      );
      const environment = entry.payload.given.environment;
      assert.equal(twin.payload.given.environment, environment);
      const answer = mocks[environment].answer("page-api", stated.call, entry.payload.request);
      stated.check(answer);
      assert.deepEqual(answer, twin.payload.outcome);
      assert.notDeepEqual(answer, entry.payload.outcome);
    });
  }

  /** The accepted exchange of the same contract and call whose request this is, in this environment, if any. */
  const twinOf = (entry, environment) =>
    acceptedExchanges.find(
      (candidate) =>
        candidate.contract === entry.contract &&
        callOf(candidate) === callOf(entry) &&
        environmentsOf(candidate.payload).includes(environment) &&
        canonicalJson(candidate.payload.request) === canonicalJson(entry.payload.request),
    );
  /** Each refused exchange in each environment its given names, with its accepted twin there (or undefined). */
  const refusedExchanges = refused.filter(isExchange).flatMap((entry) =>
    environmentsOf(entry.payload).map((environment) => ({
      entry,
      environment,
      twin: twinOf(entry, environment),
    })),
  );

  it("every refused exchange whose request no accepted fixture holds fails loudly", () => {
    const loud = refusedExchanges.filter((item) => item.twin === undefined);
    assert.ok(loud.length > 0, "the covered versions have refused exchanges with no twin");
    for (const { entry, environment } of loud) {
      const call = callOf(entry);
      assertLoud(
        ask(environment, entry.contract, call, entry.payload.request),
        "noFixture",
        entry.contract,
        call,
        entry.path,
      );
    }
  });

  it("every refused exchange whose request is an accepted twin's gets the twin's answer, never a refused outcome", () => {
    // Either the refused part is the outcome (the mock never gives it), or the fixture is its twin with only its
    // given changed (the step it states, which a named rule checks): given is never sent, so the call's answer to
    // that request is the twin's, which is that outcome.
    const twinned = refusedExchanges.filter((item) => item.twin !== undefined);
    const kinds = { outcomeRefused: [], onlyGivenRefused: [] };
    for (const { entry, environment, twin } of twinned) {
      const answer = mocks[environment].answer(entry.contract, callOf(entry), entry.payload.request);
      assert.deepEqual(answer, twin.payload.outcome, `${entry.path} (${environment})`);
      if (!isDeepStrictEqual(answer, entry.payload.outcome)) {
        kinds.outcomeRefused.push(entry.path);
        continue;
      }
      const { given: refusedGiven, ...refusedCall } = entry.payload;
      const { given: twinGiven, ...twinCall } = twin.payload;
      assert.deepEqual(refusedCall, twinCall, `${entry.path} differs from ${twin.path} outside its given`);
      assert.notDeepEqual(refusedGiven, twinGiven, `${entry.path} is ${twin.path}`);
      kinds.onlyGivenRefused.push(entry.path);
    }
    for (const stated of STATED) assert.ok(kinds.outcomeRefused.includes(stated.refused), stated.refused);
    assert.ok(kinds.outcomeRefused.length > STATED.length, JSON.stringify(kinds));
  });

  it("every refused request fails loudly", () => {
    const requests = refused.filter((entry) => entry.def?.endsWith(".request") === true);
    assert.ok(requests.length > 0, "the covered versions have refused requests");
    for (const entry of requests) {
      const call = entry.def.slice(0, -".request".length);
      for (const environment of ENVIRONMENTS) {
        assertLoud(
          ask(environment, entry.contract, call, entry.payload),
          "noFixture",
          entry.contract,
          call,
          entry.path,
        );
      }
    }
  });

  it("never holds a refused response or part as an answer", () => {
    const outcomes = new Set(acceptedExchanges.map((entry) => canonicalJson(entry.payload.outcome)));
    const parts = refused.filter((entry) => !isExchange(entry) && entry.def?.endsWith(".request") !== true);
    assert.ok(parts.length > 0, "the covered versions have refused responses or parts");
    for (const entry of parts) {
      assert.ok(!outcomes.has(canonicalJson(entry.payload)), `${entry.path}: the mock holds it as an answer`);
    }
  });
});
