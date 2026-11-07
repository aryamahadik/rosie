// Offline proof of the T-360 probe: no network and no key. Run: node --test ai/spikes/structured-outputs/
// The fake fetch below stands in for the Anthropic API (the outside boundary), never for the code under test.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  API_URL,
  CANDIDATES,
  MAX_CALLS,
  MODELS,
  buildCalls,
  bundleForModel,
  checkSubset,
  compileCandidates,
  loadCandidate,
  loadFormats,
} from "./lib.mjs";
import { main } from "./probe.mjs";

const FAKE_KEY = "test-key-not-real-0123456789";
const formats = loadFormats();
const validators = compileCandidates();

const noFetch = () => {
  throw new Error("the network was called");
};
const noWait = () => Promise.resolve();
const ignore = () => undefined;

function tempOut() {
  const dir = mkdtempSync(path.join(tmpdir(), "t360-"));
  return { dir, url: pathToFileURL(`${dir}/`) };
}

function fakeResponse(status, body, retryAfter = null) {
  return {
    status,
    headers: { get: (name) => (name === "retry-after" ? retryAfter : null) },
    text: async () => JSON.stringify(body),
  };
}

const okBody = (text) => ({
  id: "msg_fake",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 20 },
});

test("every candidate compiles in Ajv strict mode and, bundled, stays inside the structured-outputs subset", () => {
  for (const name of CANDIDATES) {
    assert.equal(typeof validators[name], "function", name);
    const bundled = bundleForModel(loadCandidate(name), formats);
    assert.deepEqual(checkSubset(bundled).problems, [], name);
    assert.ok(!JSON.stringify(bundled).includes("formats.v1.schema.json"), `${name} keeps an external $ref`);
    assert.equal(bundled.$schema, undefined);
    assert.equal(bundled.$id, undefined);
  }
});

test("bundling copies each format a schema uses, with the formats it uses, and leaves the source unchanged", () => {
  const source = {
    type: "object",
    properties: { amount: { $ref: "../common/formats.v1.schema.json#/$defs/money" } },
    required: ["amount"],
    additionalProperties: false,
  };
  const before = JSON.stringify(source);
  const bundled = bundleForModel(source, formats);
  assert.equal(JSON.stringify(source), before);
  assert.equal(bundled.properties.amount.$ref, "#/$defs/formats_money");
  assert.equal(bundled.$defs.formats_money.properties.currency.$ref, "#/$defs/formats_currency");
  assert.deepEqual(bundled.$defs.formats_currency, formats.$defs.currency);
  assert.deepEqual(checkSubset(bundled).problems, []);
});

test("the subset check flags limits, open objects, external refs and recursion", () => {
  const flagged = (schema) => checkSubset(schema).problems.length > 0;
  const object = (properties) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  assert.ok(flagged(object({ a: { type: "string", maxLength: 5 } })));
  assert.ok(flagged(object({ a: { type: "integer", minimum: 0 } })));
  assert.ok(flagged(object({ a: { type: "array", items: { type: "string" }, maxItems: 4 } })));
  assert.ok(flagged({ type: "object", properties: {}, additionalProperties: true }));
  assert.ok(flagged(object({ a: { $ref: "../x.json#/$defs/y" } })));
  assert.ok(
    flagged({
      ...object({ node: { $ref: "#/$defs/node" } }),
      $defs: { node: object({ child: { $ref: "#/$defs/node" } }) },
    }),
  );
  assert.ok(!flagged(object({ a: { type: "array", items: { type: "string" }, minItems: 1 } })));
});

test("sample outputs: the candidates accept the contracts' shapes and refuse what they forbid", () => {
  const accept = {
    decide: {
      parts: [
        {
          quote: "block thursday afternoon",
          action: {
            verb: "enter",
            target_kind: "door",
            target_id: "door-block-time",
            fields: [{ name: "when", words: "thursday afternoon" }],
          },
        },
        { quote: "thanks!", action: { verb: "no_op" } },
      ],
    },
    "safety-read": {
      labels: [
        {
          outcome: "no",
          tense: "over",
          evidence_words: ["the gas leak was fixed in March"],
          at_risk: "nobody",
          writer: "the customer",
        },
      ],
    },
    planner: { action: { verb: "pass_on", words: "is there parking at the showroom?" } },
    "message-plan": {
      format: "text",
      first_line: "You're booked: {{svc.intext}} with {{name.staff}}.",
      fact_lines: ["{{day}} · {{arrive}} · {{price}}"],
      action_line: "Manage it here:",
      link: "secure_link",
      slots: ["svc.intext", "name.staff", "day", "arrive", "price", "secure_link"],
    },
  };
  const refuse = {
    decide: { parts: [{ quote: "x", action: { verb: "book", target_id: "a" } }] },
    "safety-read": {
      labels: [{ outcome: "no", tense: "later", evidence_words: [], at_risk: "", writer: "" }],
    },
    planner: { action: { verb: "charge", amount: "$35" } },
    "message-plan": { ...accept["message-plan"], slots: ["hold"] },
  };
  for (const name of CANDIDATES) {
    assert.equal(validators[name](accept[name]), true, `${name} refused a valid sample`);
    assert.equal(validators[name](refuse[name]), false, `${name} accepted an invalid sample`);
  }
});

test("the plan: at most 20 calls, both models, every candidate on each, structured-output bodies only", () => {
  const calls = buildCalls(formats);
  assert.ok(calls.length <= MAX_CALLS);
  for (const model of MODELS) {
    for (const name of CANDIDATES) {
      assert.ok(
        calls.some((call) => call.model === model && call.schemaName === name && call.variant === "bundled"),
      );
    }
    assert.equal(calls.find((call) => call.model === model).variant, "control");
  }
  for (const call of calls) {
    assert.ok(MODELS.includes(call.model));
    assert.equal(call.body.model, call.model);
    assert.equal(call.body.output_config.format.type, "json_schema");
    for (const banned of ["temperature", "top_p", "top_k", "x-api-key", "headers"]) {
      assert.ok(!JSON.stringify(call.body).includes(banned), `${call.id} body carries ${banned}`);
    }
  }
  assert.equal(API_URL, "https://api.anthropic.com/v1/messages");
});

test("dry run passes without the network or a key", async () => {
  const lines = [];
  const code = await main(["--dry-run"], { env: {}, fetchImpl: noFetch, write: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(lines.at(-1).includes("passed"));
});

test("live refuses in CI and without a key, naming the variable, and calls nothing", async () => {
  const { dir, url } = tempOut();
  try {
    const lines = [];
    const write = (line) => lines.push(line);
    assert.equal(
      await main(["--live"], {
        env: { CI: "true", ANTHROPIC_API_KEY: FAKE_KEY },
        fetchImpl: noFetch,
        write,
        outDir: url,
      }),
      2,
    );
    assert.equal(await main(["--live"], { env: {}, fetchImpl: noFetch, write, outDir: url }), 2);
    assert.ok(lines.some((line) => line.includes("ANTHROPIC_API_KEY is not set")));
    assert.ok(!lines.join("\n").includes(FAKE_KEY));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live counts calls already logged, stops at 20, and never writes the key or a header", async () => {
  const { dir, url } = tempOut();
  try {
    writeFileSync(path.join(dir, "results.jsonl"), `${'{"earlier":true}\n'.repeat(12)}`);
    const seen = [];
    const fetchImpl = async (target, init) => {
      seen.push({ target, headers: init.headers });
      return fakeResponse(200, okBody(`{"answer":true,"echo":"${init.headers["x-api-key"]}"}`));
    };
    const lines = [];
    const code = await main(["--live"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: (line) => lines.push(line),
      outDir: url,
      sleep: noWait,
    });
    assert.equal(code, 0);
    assert.equal(seen.length, MAX_CALLS - 12);
    assert.ok(
      seen.every((call) => call.target === API_URL && call.headers["anthropic-version"] === "2026-10-21"),
    );
    const results = readFileSync(path.join(dir, "results.jsonl"), "utf8").trim().split("\n");
    assert.equal(results.length, MAX_CALLS);
    const logged = JSON.parse(results.at(-1));
    assert.equal(logged.input_tokens, 100);
    assert.equal(logged.output_tokens, 20);
    const files = readdirSync(path.join(dir, "samples"));
    assert.equal(files.length, 2 * (MAX_CALLS - 12));
    const written = [
      lines.join("\n"),
      ...results,
      ...files.map((f) => readFileSync(path.join(dir, "samples", f), "utf8")),
    ];
    for (const text of written) {
      assert.ok(!text.includes(FAKE_KEY), "the key was written");
      assert.ok(!text.includes("x-api-key"), "a header was written");
    }
    assert.equal(
      await main(["--live"], {
        env: { ANTHROPIC_API_KEY: FAKE_KEY },
        fetchImpl,
        write: ignore,
        outDir: url,
      }),
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live retries an outside failure once, and skips a model whose control call is refused", async () => {
  const { dir, url } = tempOut();
  try {
    const seen = [];
    const fetchImpl = async (_target, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.model);
      if (body.model === MODELS[0]) {
        return fakeResponse(400, {
          type: "error",
          error: { type: "invalid_request_error", message: "bad shape" },
        });
      }
      if (seen.filter((model) => model === MODELS[1]).length === 1) {
        return fakeResponse(529, {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        });
      }
      return fakeResponse(200, okBody('{"answer":true}'));
    };
    const code = await main(["--live"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: ignore,
      outDir: url,
      sleep: noWait,
    });
    assert.equal(code, 0);
    const results = readFileSync(path.join(dir, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const haiku = results.filter((line) => line.model === MODELS[0] && line.variant !== "negative");
    assert.equal(haiku.length, 1, "only Haiku's control call is made");
    assert.equal(haiku[0].refusal_or_error, "bad shape");
    const sonnetControl = results.filter((line) => line.id === "control-sonnet-5-5");
    assert.deepEqual(
      sonnetControl.map((line) => [line.attempt, line.http_status]),
      [
        [1, 529],
        [2, 200],
      ],
    );
    assert.ok(results.length <= MAX_CALLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
