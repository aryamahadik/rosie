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
import {
  FROZEN_CALLS,
  FROZEN_MODEL,
  FROZEN_TARGETS,
  buildFrozenCalls,
  compileFrozen,
  frozenSamples,
} from "./frozen.mjs";
import {
  MODEL_FACING,
  bundleSchema,
  lintSchema,
} from "../../../contracts/scripts/structured-subset-lint.mjs";

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

// ---------------------------------------------------------------------------------------------------------
// T-1066: --frozen sends the frozen contracts' own model-facing schemas, bundled the way the gateway will.

const FROZEN_DEFS = ["decideRead", "safetyRead", "plannerOutput", "plan"];
const frozenValidators = compileFrozen();
const frozenSampleOutputs = frozenSamples();
const contractJson = (file) =>
  JSON.parse(readFileSync(new URL(`../../../contracts/${file}`, import.meta.url), "utf8"));

/** A temp output folder whose results.jsonl already logs `logged` calls (T-360 logged 16). */
function tempOutWithLog(logged) {
  const out = tempOut();
  writeFileSync(path.join(out.dir, "results.jsonl"), '{"earlier":true}\n'.repeat(logged));
  return out;
}

const frozenOutputs = () => FROZEN_DEFS.map((def) => JSON.stringify(frozenSampleOutputs[def]));

test("frozen plan: exactly 4 calls on Haiku, one per frozen schema, each as bundleSchema() builds it", () => {
  assert.deepEqual(
    FROZEN_TARGETS.map((target) => target.def),
    FROZEN_DEFS,
  );
  assert.deepEqual(FROZEN_TARGETS.slice(0, 3), MODEL_FACING.slice(0, 3));
  assert.equal(FROZEN_CALLS, 4);
  assert.equal(FROZEN_MODEL, "claude-haiku-5-5");
  const calls = buildFrozenCalls({ firstN: 17 });
  assert.equal(calls.length, FROZEN_CALLS);
  assert.deepEqual(
    calls.map((call) => call.n),
    [17, 18, 19, 20],
  );
  assert.deepEqual(
    calls.map((call) => call.id),
    [
      "frozen-decide-read-haiku-5-5",
      "frozen-safety-read-haiku-5-5",
      "frozen-planner-output-haiku-5-5",
      "frozen-plan-haiku-5-5",
    ],
  );
  calls.forEach((call, k) => {
    const target = FROZEN_TARGETS[k];
    const schema = call.body.output_config.format.schema;
    assert.equal(call.model, FROZEN_MODEL);
    assert.equal(call.body.model, FROZEN_MODEL);
    assert.equal(call.schemaName, target.def);
    assert.deepEqual(schema, bundleSchema({ schema: target.schema, def: target.def }));
    assert.equal(call.body.output_config.format.type, "json_schema");
    assert.equal(schema.$schema, undefined);
    assert.equal(schema.$id, undefined);
    assert.deepEqual(checkSubset(schema).problems, [], call.id);
    assert.deepEqual(lintSchema(schema).errors, [], call.id);
    const wire = JSON.stringify(call.body);
    for (const banned of ["temperature", "top_p", "top_k", "x-api-key", "headers", "undefined", "[object"]) {
      assert.ok(!wire.includes(banned), `${call.id} body carries ${banned}`);
    }
    assert.ok(!wire.includes('"$ref":"../'), `${call.id} keeps a relative $ref`);
  });
});

test("frozen prompts are built from the frozen fixtures", () => {
  const [decide, safety, planner, plan] = buildFrozenCalls().map((call) => call.body.messages[0].content);
  assert.ok(decide.includes("Barbershop, plumbing, electrical"));
  assert.ok(decide.includes("c-01") && decide.includes("oq-s1-02"));
  assert.ok(safety.includes("the gas leak was fixed in March"));
  assert.ok(planner.includes("pay.noshow"));
  assert.ok(plan.includes("S1-02") && plan.includes("<allowed_formats>text</allowed_formats>"));
});

test("frozen validators accept the contracts' fixture outputs and refuse what the contracts forbid", () => {
  for (const def of FROZEN_DEFS) {
    assert.equal(frozenValidators[def](frozenSampleOutputs[def]), true, `${def} refused its fixture output`);
  }
  assert.equal(
    frozenValidators.decideRead(contractJson("model/fixtures/invalid/refuse-unknown-verb.json")),
    false,
  );
  assert.equal(
    frozenValidators.plannerOutput(contractJson("model/fixtures/invalid/refuse-planner-books.json")),
    false,
  );
  const hold = structuredClone(frozenSampleOutputs.plan);
  hold.lines[0].text = "Your {{hold}} is ready.";
  assert.equal(frozenValidators.plan(hold), false);
});

test("frozen dry run passes offline, with 16 calls logged, with the folder as it is, and with the limit spent", async () => {
  for (const logged of [16, 20]) {
    const { dir, url } = tempOutWithLog(logged);
    try {
      const lines = [];
      const code = await main(["--frozen", "--dry-run"], {
        env: {},
        fetchImpl: noFetch,
        write: (line) => lines.push(line),
        outDir: url,
      });
      assert.equal(code, 0, lines.join("\n"));
      assert.ok(lines.at(-1).includes("passed"));
      assert.equal(lines.filter((line) => line.startsWith("ok  ")).length, FROZEN_CALLS);
      assert.equal(
        lines.some((line) => line.includes("would refuse")),
        logged === 20,
      );
      assert.deepEqual(readdirSync(dir), ["results.jsonl"], "a dry run writes nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const lines = [];
  assert.equal(
    await main(["--frozen", "--dry-run"], { env: {}, fetchImpl: noFetch, write: (l) => lines.push(l) }),
    0,
  );
});

test("frozen live: 4 calls on Haiku, logged from 17, outputs checked against the frozen defs, no key written", async () => {
  const { dir, url } = tempOutWithLog(16);
  try {
    const outputs = frozenOutputs();
    const seen = [];
    const fetchImpl = async (target, init) => {
      const body = JSON.parse(init.body);
      seen.push({ target, model: body.model, version: init.headers["anthropic-version"] });
      return fakeResponse(200, okBody(outputs[seen.length - 1]));
    };
    const lines = [];
    const options = {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: (l) => lines.push(l),
      outDir: url,
    };
    assert.equal(await main(["--frozen", "--live"], { ...options, sleep: noWait }), 0, lines.join("\n"));
    assert.equal(seen.length, FROZEN_CALLS);
    assert.ok(seen.every((call) => call.target === API_URL && call.model === FROZEN_MODEL));
    assert.ok(seen.every((call) => call.version === "2026-10-21"));
    const results = readFileSync(path.join(dir, "results.jsonl"), "utf8").trim().split("\n");
    assert.equal(results.length, MAX_CALLS);
    const logged = results.slice(16).map((line) => JSON.parse(line));
    assert.deepEqual(
      logged.map((line) => [line.call_number, line.n, line.schema, line.accepted, line.output_valid]),
      [
        [17, 17, "decideRead", true, true],
        [18, 18, "safetyRead", true, true],
        [19, 19, "plannerOutput", true, true],
        [20, 20, "plan", true, true],
      ],
    );
    assert.ok(logged.every((line) => line.variant === "frozen" && line.input_tokens === 100));
    const files = readdirSync(path.join(dir, "samples")).sort();
    assert.deepEqual(
      files,
      FROZEN_DEFS.flatMap((def, k) => {
        const id = ["decide-read", "safety-read", "planner-output", "plan"][k];
        return [
          `${17 + k}-frozen-${id}-haiku-5-5.request.json`,
          `${17 + k}-frozen-${id}-haiku-5-5.response.json`,
        ];
      }),
    );
    const written = [
      lines.join("\n"),
      ...results,
      ...files.map((f) => readFileSync(path.join(dir, "samples", f), "utf8")),
    ];
    for (const text of written) {
      assert.ok(!text.includes(FAKE_KEY), "the key was written");
      assert.ok(!text.includes("x-api-key"), "a header was written");
    }
    // The limit is spent: a second run refuses and calls nothing.
    assert.equal(await main(["--frozen", "--live"], { ...options, fetchImpl: noFetch }), 2);
    assert.equal(readFileSync(path.join(dir, "results.jsonl"), "utf8").trim().split("\n").length, MAX_CALLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frozen live records a refusal with its text and an output that does not validate", async () => {
  const { dir, url } = tempOutWithLog(16);
  try {
    const outputs = frozenOutputs();
    outputs[1] = '{"labels":[{"outcome":"Maybe"}]}';
    let count = 0;
    const fetchImpl = async () => {
      count += 1;
      if (count === 1) {
        return fakeResponse(400, {
          type: "error",
          error: { type: "invalid_request_error", message: "Schema is too complex." },
        });
      }
      return fakeResponse(200, okBody(outputs[count - 1]));
    };
    const code = await main(["--frozen", "--live"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: ignore,
      outDir: url,
      sleep: noWait,
    });
    assert.equal(code, 0);
    assert.equal(count, FROZEN_CALLS, "a 400 is a finding, not an outside failure: no retry");
    const logged = readFileSync(path.join(dir, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .slice(16)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      logged.map((line) => [line.schema, line.accepted, line.refusal_or_error, line.output_valid]),
      [
        ["decideRead", false, "Schema is too complex.", null],
        ["safetyRead", true, null, false],
        ["plannerOutput", true, null, true],
        ["plan", true, null, true],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frozen live refuses with fewer than 4 calls left, in CI and without a key, and calls nothing", async () => {
  const lines = [];
  const write = (line) => lines.push(line);
  const { dir, url } = tempOutWithLog(17);
  try {
    assert.equal(
      await main(["--frozen", "--live"], {
        env: { ANTHROPIC_API_KEY: FAKE_KEY },
        fetchImpl: noFetch,
        write,
        outDir: url,
      }),
      2,
    );
    assert.ok(lines.some((line) => line.includes("only 3 of the 20 are left")));
    assert.deepEqual(readdirSync(dir), ["results.jsonl"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const sixteen = tempOutWithLog(16);
  try {
    assert.equal(
      await main(["--frozen", "--live"], {
        env: { CI: "true", ANTHROPIC_API_KEY: FAKE_KEY },
        fetchImpl: noFetch,
        write,
        outDir: sixteen.url,
      }),
      2,
    );
    assert.equal(
      await main(["--frozen", "--live"], { env: {}, fetchImpl: noFetch, write, outDir: sixteen.url }),
      2,
    );
    assert.ok(lines.some((line) => line.includes("ANTHROPIC_API_KEY is not set")));
    assert.ok(!lines.join("\n").includes(FAKE_KEY));
    assert.deepEqual(readdirSync(sixteen.dir), ["results.jsonl"]);
  } finally {
    rmSync(sixteen.dir, { recursive: true, force: true });
  }
});

test("the flags: --frozen needs exactly one of --dry-run and --live, and nothing else is taken", async () => {
  for (const argv of [
    ["--frozen"],
    ["--dry-run", "--live"],
    ["--frozen", "--frozen", "--live"],
    ["--frozen", "--dry-run", "--x"],
    [],
  ]) {
    const lines = [];
    const code = await main(argv, { env: {}, fetchImpl: noFetch, write: (l) => lines.push(l) });
    assert.equal(code, 2, argv.join(" "));
    assert.ok(lines[0].startsWith("Usage:"));
  }
});
