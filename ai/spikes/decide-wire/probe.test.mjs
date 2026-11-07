// Offline proof of the T-1068 probe: no network and no key. Run: node --test ai/spikes/decide-wire/
// The fake fetch below stands in for the Anthropic API (the outside boundary), never for the code under test. Its
// answers are the frozen K-02 fixtures' own reads, put into each wire form.
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
  ONE_CALL,
  VERBS,
  buildCalls,
  buildFollowUps,
  buildSonnetTwoStep,
  buildStage2Calls,
  chooseStrongest,
  compileDecideRead,
  compileWire,
  contractJson,
  decideTools,
  decodeValue,
  encodeValue,
  envelopeSchema,
  expectedRead,
  lintRequest,
  mapAndValidate,
  mapEnvelope,
  mapToolBlocks,
  mapTwoStep,
  toEnvelope,
  toToolBlocks,
  toTwoStep,
  wireSchemas,
} from "./lib.mjs";
import { main, roundTrip, sampleReads } from "./probe.mjs";
import { bundleSchema, lintSchema } from "../../../contracts/scripts/structured-subset-lint.mjs";

const FAKE_KEY = "test-key-not-real-0123456789";
const wire = compileWire();
const decideRead = compileDecideRead();

const noFetch = () => {
  throw new Error("the network was called");
};
const noWait = () => Promise.resolve();
const ignore = () => undefined;

function tempOut(logged = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), "t1068-"));
  if (logged > 0) writeFileSync(path.join(dir, "results.jsonl"), '{"earlier":true}\n'.repeat(logged));
  return { dir, url: pathToFileURL(`${dir}/`) };
}

function fakeResponse(status, body, retryAfter = null) {
  return {
    status,
    headers: { get: (name) => (name === "retry-after" ? retryAfter : null) },
    text: async () => JSON.stringify(body),
  };
}

const message = (content, stopReason) => ({
  id: "msg_fake",
  type: "message",
  role: "assistant",
  content,
  stop_reason: stopReason,
  usage: { input_tokens: 100, output_tokens: 20 },
});

/** What the fake API answers: the expected fixture read of the request's case, in the request's wire form. */
function fakeAnswer(body) {
  const user = body.messages[0].content;
  const caseName = user.includes("tile is $12") ? "two-requests" : "s1-02";
  const read = expectedRead(caseName);
  if (Array.isArray(body.tools)) {
    const flat = body.tools[0].input_schema.$defs.field?.properties?.type !== undefined;
    return message([{ type: "text", text: "Two parts." }, ...toToolBlocks(read, { flat })], "tool_use");
  }
  const schema = body.output_config.format.schema;
  let output;
  if (schema.$defs?.part !== undefined) output = toEnvelope(read);
  else if (schema.properties.parts !== undefined) output = toTwoStep(read).stage1;
  else {
    const quote = /<part>verb \w+; quote: (.*)<\/part>/.exec(user)?.[1];
    const k = read.parts.findIndex((part) => part.quote === quote);
    output = toTwoStep(read).stage2[k];
  }
  return message([{ type: "text", text: JSON.stringify(output) }], "end_turn");
}

const readLines = (dir) =>
  readFileSync(path.join(dir, "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("the wire schemas compile, stay inside the subset, and the tools are cut from the frozen K-02 parts", () => {
  const schemas = wireSchemas();
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(typeof wire[name], "function", name);
    assert.deepEqual(lintSchema(schema).errors, [], name);
    assert.equal(schema.$schema, undefined, name);
    assert.equal(schema.$id, undefined, name);
    assert.ok(!JSON.stringify(schema).includes('"$ref":"../'), `${name} keeps a relative $ref`);
  }
  const tools = decideTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    VERBS.map((v) => v.verb),
  );
  for (const tool of tools) {
    assert.equal(tool.strict, true);
    const def = VERBS.find((v) => v.verb === tool.name).def;
    const part = bundleSchema({ schema: "model/model.v1.schema.json", def });
    const { verb: verbProperty, ...rest } = part.properties;
    assert.equal(verbProperty.const, tool.name);
    assert.deepEqual(tool.input_schema.properties, {
      language: tool.input_schema.properties.language,
      ...rest,
    });
    assert.deepEqual(tool.input_schema.required, ["language", ...part.required.filter((r) => r !== "verb")]);
    assert.equal(tool.description, contractJson("model/model.v1.schema.json").$defs[def].description);
  }
});

test("per request: the envelope, stage 1 and the flat tools carry no union; the K-02 tools carry K-02's two", () => {
  const counts = Object.fromEntries(buildCalls().map((call) => [call.candidate, lintRequest(call.body)]));
  assert.deepEqual(
    [counts.tools.strictTools, counts.tools.unionParameters, counts.tools.optionalProperties],
    [8, 2, 0],
  );
  assert.deepEqual(
    [
      counts["tools-flat"].strictTools,
      counts["tools-flat"].unionParameters,
      counts["tools-flat"].optionalProperties,
    ],
    [8, 0, 0],
  );
  assert.deepEqual([counts.envelope.unionParameters, counts.envelope.optionalProperties], [0, 0]);
  assert.deepEqual([counts["two-step"].unionParameters, counts["two-step"].optionalProperties], [0, 0]);
  for (const result of Object.values(counts)) assert.deepEqual(result.errors, []);
  assert.equal(JSON.stringify(envelopeSchema()).includes("anyOf"), false);
});

test("every decide fixture's reads map through every candidate and back to the same valid decideRead", () => {
  const { valid } = sampleReads();
  const names = valid.map((sample) => sample.name);
  for (const named of [
    "decide-s1-02-choose#1",
    "decide-two-requests#1",
    "decide-hand-off#1",
    "decide-redact#1",
  ]) {
    assert.ok(names.includes(named), named);
  }
  const verbs = new Set(valid.flatMap((sample) => sample.read.parts.map((part) => part.verb)));
  assert.deepEqual([...verbs].sort(), VERBS.map((v) => v.verb).sort(), "the samples cover all eight verbs");
  const types = new Set(
    valid.flatMap((sample) =>
      sample.read.parts.flatMap((part) => (part.fields ?? []).map((field) => encodeValue(field.value).type)),
    ),
  );
  assert.deepEqual(
    [...types].sort(),
    ["boolean", "integer", "money", "text", "time"],
    "and every value type",
  );
  for (const candidate of CANDIDATES) {
    for (const sample of valid) {
      assert.deepEqual(
        roundTrip(candidate, sample.read, { wire, decideRead }),
        { wireValid: true, mappedValid: true, same: true },
        `${candidate} ${sample.name}`,
      );
    }
  }
});

test("the invalid reads (an unknown verb, a value without words) are refused by every candidate", () => {
  const { invalid } = sampleReads();
  assert.deepEqual(invalid.map((sample) => sample.name).sort(), [
    "invalid/refuse-unknown-verb",
    "invalid/refuse-value-without-words",
  ]);
  for (const candidate of CANDIDATES) {
    for (const sample of invalid) {
      const result = roundTrip(candidate, sample.read, { wire, decideRead });
      assert.ok(!result.wireValid || !result.mappedValid, `${candidate} accepted ${sample.name}`);
    }
  }
});

test("typed text: every K-02 value type goes there and back; bad text is a mapping error, not a guess", () => {
  for (const value of [
    "tile",
    3,
    -2,
    true,
    false,
    { cents: 1200, currency: "USD" },
    { utc: "2026-11-12T19:00:00Z", zone: "America/New_York" },
  ]) {
    const { type, value: text } = encodeValue(value);
    assert.deepEqual(decodeValue(type, text), { value }, JSON.stringify(value));
  }
  assert.ok(decodeValue("money", "$12").error);
  assert.ok(decodeValue("integer", "twelve").error);
  assert.ok(decodeValue("boolean", "yes").error);
  assert.ok(decodeValue("time", "thursday").error);
});

test("mapping errors: no tool call, mixed languages, hand_off about none, a bad money text, a missing stage 2", () => {
  assert.deepEqual(mapToolBlocks([{ type: "text", text: "hi" }]).errors, ["no tool call"]);
  const blocks = toToolBlocks(expectedRead("two-requests"));
  blocks[1].input.language = "es";
  assert.ok(mapToolBlocks(blocks).errors[0].includes("different languages"));
  assert.equal(mapAndValidate("tools", blocks, decideRead).valid, false);

  const handOff = toEnvelope({
    language: "en",
    parts: [{ verb: "hand_off", quote: "can I talk to Sam", reason: "asks for Sam", about: "other" }],
  });
  handOff.parts[0].about = "none";
  assert.ok(mapEnvelope(handOff).errors[0].includes("not none"));
  assert.equal(mapAndValidate("envelope", handOff, decideRead).valid, false);

  const money = toEnvelope(expectedRead("two-requests"));
  money.parts[1].fields[1].value = "$12 a foot";
  assert.ok(mapEnvelope(money).errors[0].includes("money"));
  assert.equal(mapAndValidate("envelope", money, decideRead).valid, false);

  const twoStep = toTwoStep(expectedRead("two-requests"));
  assert.ok(mapTwoStep(twoStep.stage1, [twoStep.stage2[0]]).errors[0].includes("part 2"));
});

test("the plan: 4 first-round calls on Haiku, 2 second-round candidates on Sonnet and on S1-02, a retry slot left", () => {
  const first = buildCalls();
  assert.deepEqual(
    first.map((call) => [call.candidate, call.model, call.caseName]),
    CANDIDATES.map((candidate) => [candidate, MODELS[0], "two-requests"]),
  );
  const stage2 = buildStage2Calls(first[3], toTwoStep(expectedRead("two-requests")).stage1);
  assert.equal(stage2.length, 2);
  const second = buildFollowUps(["tools", "envelope"]);
  assert.deepEqual(
    second.map((call) => [call.candidate, call.model, call.caseName]),
    [
      ["tools", MODELS[1], "two-requests"],
      ["envelope", MODELS[1], "two-requests"],
      ["tools", MODELS[0], "s1-02"],
      ["envelope", MODELS[0], "s1-02"],
    ],
  );
  assert.ok(first.length + stage2.length + second.length < MAX_CALLS, "one retry slot stays free");
  for (const call of [...first, ...stage2, ...buildFollowUps(ONE_CALL)]) {
    const body = JSON.stringify(call.body);
    for (const banned of ["temperature", "top_p", "top_k", "x-api-key", "headers", "undefined", "[object"]) {
      assert.ok(!body.includes(banned), `${call.id} body carries ${banned}`);
    }
    assert.ok(MODELS.includes(call.body.model));
    if (call.body.tools) assert.deepEqual(call.body.tool_choice, { type: "auto" });
    assert.ok(call.body.messages[0].content.includes("<turn>"));
  }
  assert.equal(API_URL, "https://api.anthropic.com/v1/messages");
});

test("the second round takes accepted candidates with a valid mapping first, then accepted ones, at most two", () => {
  const line = (candidate, accepted, mappedValid) => ({
    candidate,
    model: MODELS[0],
    accepted,
    mapped_valid: mappedValid,
  });
  assert.deepEqual(
    chooseStrongest([
      line("tools", false, null),
      line("tools-flat", true, false),
      line("envelope", true, true),
    ]),
    ["envelope", "tools-flat"],
  );
  assert.deepEqual(
    chooseStrongest([
      line("tools", true, true),
      line("tools-flat", true, true),
      line("envelope", true, true),
    ]),
    ["tools", "tools-flat"],
  );
  assert.deepEqual(chooseStrongest([line("tools", false, null), line("envelope", false, null)]), []);
});

test("dry run passes without the network or a key and writes nothing", async () => {
  const { dir, url } = tempOut();
  try {
    const lines = [];
    const code = await main(["--dry-run"], {
      env: {},
      fetchImpl: noFetch,
      write: (l) => lines.push(l),
      outDir: url,
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.ok(lines.at(-1).includes("passed"));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live refuses in CI, without a key and with the 12 calls spent, and calls nothing", async () => {
  const { dir, url } = tempOut();
  const spent = tempOut(MAX_CALLS);
  try {
    const lines = [];
    const write = (l) => lines.push(l);
    const withKey = { ANTHROPIC_API_KEY: FAKE_KEY };
    assert.equal(
      await main(["--live"], { env: { CI: "true", ...withKey }, fetchImpl: noFetch, write, outDir: url }),
      2,
    );
    assert.equal(await main(["--live"], { env: {}, fetchImpl: noFetch, write, outDir: url }), 2);
    assert.equal(await main(["--live"], { env: withKey, fetchImpl: noFetch, write, outDir: spent.url }), 2);
    assert.ok(lines.some((l) => l.includes("ANTHROPIC_API_KEY is not set")));
    assert.ok(lines.some((l) => l.includes("already logs 12 calls")));
    assert.ok(!lines.join("\n").includes(FAKE_KEY));
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(readdirSync(spent.dir), ["results.jsonl"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(spent.dir, { recursive: true, force: true });
  }
});

test("live against a fake API: 10 calls, each answer checked on the wire and mapped into a valid decideRead", async () => {
  const { dir, url } = tempOut();
  try {
    const seen = [];
    const fetchImpl = async (target, init) => {
      const body = JSON.parse(init.body);
      seen.push({ target, version: init.headers["anthropic-version"], model: body.model });
      return fakeResponse(200, fakeAnswer(body));
    };
    const lines = [];
    const code = await main(["--live"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: (l) => lines.push(l),
      outDir: url,
      sleep: noWait,
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.equal(seen.length, 10);
    assert.ok(seen.every((s) => s.target === API_URL && s.version === "2026-10-21"));
    const results = readLines(dir);
    assert.deepEqual(
      results.map((r) => [r.id, r.accepted, r.wire_valid, r.mapped_valid, r.same_as_fixture]),
      [
        ["tools-two-requests-haiku-5-5", true, true, true, true],
        ["tools-flat-two-requests-haiku-5-5", true, true, true, true],
        ["envelope-two-requests-haiku-5-5", true, true, true, true],
        ["two-step-1-two-requests-haiku-5-5", true, true, null, null],
        ["two-step-2-p1-two-requests-haiku-5-5", true, true, null, null],
        ["two-step-2-p2-two-requests-haiku-5-5", true, true, true, true],
        ["tools-two-requests-sonnet-5-5", true, true, true, true],
        ["tools-flat-two-requests-sonnet-5-5", true, true, true, true],
        ["tools-s1-02-haiku-5-5", true, true, true, true],
        ["tools-flat-s1-02-haiku-5-5", true, true, true, true],
      ],
    );
    assert.deepEqual(
      results.map((r) => r.call_number),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.equal(results[0].tool_calls, 2);
    assert.equal(results[0].input_tokens, 100);
    const files = readdirSync(path.join(dir, "samples"));
    assert.equal(files.length, 20);
    for (const text of [
      lines.join("\n"),
      ...results.map((r) => JSON.stringify(r)),
      ...files.map((f) => readFileSync(path.join(dir, "samples", f), "utf8")),
    ]) {
      assert.ok(!text.includes(FAKE_KEY), "the key was written");
      assert.ok(!text.includes("x-api-key"), "a header was written");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live records 'too complex' with its text, sends Sonnet only accepted forms, and keeps to the cap", async () => {
  const { dir, url } = tempOut(3);
  try {
    let count = 0;
    const fetchImpl = async (_target, init) => {
      count += 1;
      const body = JSON.parse(init.body);
      if (
        Array.isArray(body.tools) &&
        body.tools[0].input_schema.$defs.field?.properties?.type === undefined
      ) {
        return fakeResponse(400, {
          type: "error",
          error: { type: "invalid_request_error", message: "Schema is too complex for compilation." },
        });
      }
      return fakeResponse(200, fakeAnswer(body));
    };
    assert.equal(
      await main(["--live"], {
        env: { ANTHROPIC_API_KEY: FAKE_KEY },
        fetchImpl,
        write: ignore,
        outDir: url,
        sleep: noWait,
      }),
      0,
    );
    assert.equal(count, MAX_CALLS - 3, "stops at the cap, counting the 3 lines already logged");
    const results = readLines(dir).slice(3);
    assert.deepEqual(
      [results[0].id, results[0].accepted, results[0].refusal_or_error, results[0].mapped_valid],
      ["tools-two-requests-haiku-5-5", false, "Schema is too complex for compilation.", null],
    );
    assert.ok(
      results.every((r) => r.model === MODELS[0] || r.candidate !== "tools"),
      "Sonnet never gets tools",
    );
    assert.deepEqual(
      results.filter((r) => r.model === MODELS[1]).map((r) => r.candidate),
      ["tools-flat", "envelope"],
    );
    assert.equal(results.length, MAX_CALLS - 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live retries an outside failure once and stops at a key problem", async () => {
  const flaky = tempOut();
  const denied = tempOut();
  try {
    let calls = 0;
    const fetchImpl = async (_target, init) => {
      calls += 1;
      if (calls === 1)
        return fakeResponse(529, {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        });
      return fakeResponse(200, fakeAnswer(JSON.parse(init.body)));
    };
    await main(["--live"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: ignore,
      outDir: flaky.url,
      sleep: noWait,
    });
    const first = readLines(flaky.dir).filter((r) => r.id === "tools-two-requests-haiku-5-5");
    assert.deepEqual(
      first.map((r) => [r.attempt, r.http_status, r.mapped_valid]),
      [
        [1, 529, null],
        [2, 200, true],
      ],
    );
    assert.equal(readLines(flaky.dir).length, 11, "the retry takes the spare slot; 1 is left");

    let deniedCalls = 0;
    const deny = async () => {
      deniedCalls += 1;
      return fakeResponse(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      });
    };
    await main(["--live"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl: deny,
      write: ignore,
      outDir: denied.url,
      sleep: noWait,
    });
    assert.equal(deniedCalls, 1);
  } finally {
    rmSync(flaky.dir, { recursive: true, force: true });
    rmSync(denied.dir, { recursive: true, force: true });
  }
});

test("round two: the plan is the two-step candidate on Sonnet, 3 calls for two parts, 3 left for retries", () => {
  const head = buildSonnetTwoStep();
  assert.equal(head.id, "two-step-1-two-requests-sonnet-5-5");
  assert.deepEqual(
    [head.candidate, head.stage, head.model, head.caseName],
    ["two-step", 1, MODELS[1], "two-requests"],
  );
  assert.equal(head.body.model, MODELS[1]);
  assert.equal(head.body.tools, undefined);
  const stage2 = buildStage2Calls(head, toTwoStep(expectedRead("two-requests")).stage1);
  assert.deepEqual(
    stage2.map((call) => [call.id, call.model, call.stage]),
    [
      ["two-step-2-p1-two-requests-sonnet-5-5", MODELS[1], 2],
      ["two-step-2-p2-two-requests-sonnet-5-5", MODELS[1], 2],
    ],
  );
  assert.ok(1 + stage2.length + 1 <= MAX_CALLS - 6, "with 6 calls logged, at least 1 slot stays free");
  for (const call of [head, ...stage2]) {
    assert.deepEqual(lintRequest(call.body).errors, [], call.id);
    for (const banned of ["temperature", "top_p", "top_k", "x-api-key", "headers", "undefined", "[object"]) {
      assert.ok(!JSON.stringify(call.body).includes(banned), `${call.id} body carries ${banned}`);
    }
  }
});

test("round two live against a fake API: 3 Sonnet calls appended after the 6 logged, mapped valid and equal to the fixture", async () => {
  const { dir, url } = tempOut(6);
  try {
    const seen = [];
    const fetchImpl = async (target, init) => {
      const body = JSON.parse(init.body);
      seen.push({ target, model: body.model, tools: body.tools });
      return fakeResponse(200, fakeAnswer(body));
    };
    const lines = [];
    const code = await main(["--live", "--round", "two-step-sonnet"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: (l) => lines.push(l),
      outDir: url,
      sleep: noWait,
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.equal(seen.length, 3);
    assert.ok(seen.every((s) => s.target === API_URL && s.model === MODELS[1] && s.tools === undefined));
    const results = readLines(dir).slice(6);
    assert.deepEqual(
      results.map((r) => [r.id, r.call_number, r.accepted, r.wire_valid, r.mapped_valid, r.same_as_fixture]),
      [
        ["two-step-1-two-requests-sonnet-5-5", 7, true, true, null, null],
        ["two-step-2-p1-two-requests-sonnet-5-5", 8, true, true, null, null],
        ["two-step-2-p2-two-requests-sonnet-5-5", 9, true, true, true, true],
      ],
    );
    assert.equal(readLines(dir).length, 9);
    const files = readdirSync(path.join(dir, "samples"));
    assert.equal(files.length, 6);
    for (const text of [
      lines.join("\n"),
      ...results.map((r) => JSON.stringify(r)),
      ...files.map((f) => readFileSync(path.join(dir, "samples", f), "utf8")),
    ]) {
      assert.ok(!text.includes(FAKE_KEY), "the key was written");
      assert.ok(!text.includes("x-api-key"), "a header was written");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round two refuses in CI, without a key, with the cap spent and when it already ran, and calls nothing", async () => {
  const fresh = tempOut();
  const spent = tempOut(MAX_CALLS);
  const done = tempOut();
  try {
    writeFileSync(
      path.join(done.dir, "results.jsonl"),
      `${JSON.stringify({ id: "two-step-1-two-requests-sonnet-5-5" })}\n`,
    );
    const lines = [];
    const write = (l) => lines.push(l);
    const argv = ["--live", "--round", "two-step-sonnet"];
    const withKey = { ANTHROPIC_API_KEY: FAKE_KEY };
    assert.equal(
      await main(argv, { env: { CI: "1", ...withKey }, fetchImpl: noFetch, write, outDir: fresh.url }),
      2,
    );
    assert.equal(await main(argv, { env: {}, fetchImpl: noFetch, write, outDir: fresh.url }), 2);
    assert.equal(await main(argv, { env: withKey, fetchImpl: noFetch, write, outDir: spent.url }), 2);
    assert.equal(await main(argv, { env: withKey, fetchImpl: noFetch, write, outDir: done.url }), 2);
    assert.ok(lines.some((l) => l.includes("runs once")));
    assert.deepEqual(readdirSync(fresh.dir), []);
    assert.deepEqual(readdirSync(done.dir), ["results.jsonl"]);
  } finally {
    for (const t of [fresh, spent, done]) rmSync(t.dir, { recursive: true, force: true });
  }
});

test("round two stops at the cap and retries an outside failure once", async () => {
  const { dir, url } = tempOut(MAX_CALLS - 2);
  try {
    let count = 0;
    const fetchImpl = async (_target, init) => {
      count += 1;
      return fakeResponse(200, fakeAnswer(JSON.parse(init.body)));
    };
    await main(["--live", "--round", "two-step-sonnet"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: ignore,
      outDir: url,
      sleep: noWait,
    });
    assert.equal(count, 2, "only the 2 calls left under the cap are made");
    assert.equal(readLines(dir).length, MAX_CALLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const flaky = tempOut(6);
  try {
    let calls = 0;
    const fetchImpl = async (_target, init) => {
      calls += 1;
      if (calls === 1)
        return fakeResponse(529, {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        });
      return fakeResponse(200, fakeAnswer(JSON.parse(init.body)));
    };
    await main(["--live", "--round", "two-step-sonnet"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: ignore,
      outDir: flaky.url,
      sleep: noWait,
    });
    const results = readLines(flaky.dir).slice(6);
    assert.deepEqual(
      results.map((r) => [r.id, r.attempt, r.http_status]),
      [
        ["two-step-1-two-requests-sonnet-5-5", 1, 529],
        ["two-step-1-two-requests-sonnet-5-5", 2, 200],
        ["two-step-2-p1-two-requests-sonnet-5-5", 1, 200],
        ["two-step-2-p2-two-requests-sonnet-5-5", 1, 200],
      ],
    );
    assert.equal(results.at(-1).mapped_valid, true);
  } finally {
    rmSync(flaky.dir, { recursive: true, force: true });
  }
});

test("a full run where only the two-step form is accepted also sends it on Sonnet, within the cap", async () => {
  const { dir, url } = tempOut();
  try {
    const fetchImpl = async (_target, init) => {
      const body = JSON.parse(init.body);
      const oneCall = Array.isArray(body.tools) || body.output_config.format.schema.$defs?.part !== undefined;
      if (oneCall)
        return fakeResponse(400, {
          type: "error",
          error: { type: "invalid_request_error", message: "Schema is too complex." },
        });
      return fakeResponse(200, fakeAnswer(body));
    };
    await main(["--live"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      fetchImpl,
      write: ignore,
      outDir: url,
      sleep: noWait,
    });
    const results = readLines(dir);
    assert.deepEqual(
      results.map((r) => [r.id, r.accepted]),
      [
        ["tools-two-requests-haiku-5-5", false],
        ["tools-flat-two-requests-haiku-5-5", false],
        ["envelope-two-requests-haiku-5-5", false],
        ["two-step-1-two-requests-haiku-5-5", true],
        ["two-step-2-p1-two-requests-haiku-5-5", true],
        ["two-step-2-p2-two-requests-haiku-5-5", true],
        ["two-step-1-two-requests-sonnet-5-5", true],
        ["two-step-2-p1-two-requests-sonnet-5-5", true],
        ["two-step-2-p2-two-requests-sonnet-5-5", true],
      ],
    );
    assert.ok(results.length < MAX_CALLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the flags: exactly one of --dry-run and --live, or --live --round two-step-sonnet", async () => {
  for (const argv of [
    [],
    ["--dry-run", "--live"],
    ["--live", "--live"],
    ["--frozen"],
    ["--dry-run", "--x"],
    ["--live", "--round"],
    ["--live", "--round", "other"],
    ["--dry-run", "--round", "two-step-sonnet"],
    ["--round", "two-step-sonnet", "--live"],
    ["--live", "--round", "two-step-sonnet", "--live"],
  ]) {
    const lines = [];
    assert.equal(
      await main(argv, { env: {}, fetchImpl: noFetch, write: (l) => lines.push(l) }),
      2,
      argv.join(" "),
    );
    assert.ok(lines[0].startsWith("Usage:"));
  }
});
