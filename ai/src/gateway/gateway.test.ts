// Tests of the AI gateway (T-361, C-121). No live call anywhere: every test hands the gateway a fake `fetch` (a fake
// Messages API), and the global fetch is stubbed to fail the file if anything reaches it. Time is vitest's fake clock.
// Answers the fake API gives come from the recorded-model double or are written here; spans are held to K-08 v1's own
// schema (Ajv 2020, through the runtime's trace test-support) and to its trace-model-call-cost.json fixture.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadRecordedModel, type JsonObject } from "../recorded-double";
import { openTrace, spanProblems, type BundleId, type Span } from "../../../runtime/src/trace";
import { eventTraceFixture, schemaErrors } from "../../../runtime/src/trace/test-support";
import {
  ALLOWED_MODELS,
  API_URL,
  API_VERSION,
  GATEWAY_PURPOSES,
  GatewayConfigError,
  HAIKU_MODEL,
  KEY_VARIABLE,
  MissingKeyError,
  NotForTheGatewayError,
  PRICE_LIST,
  SONNET_MODEL,
  STAGE_OF,
  STAGE_TIMEOUT_MS,
  costMicroUsd,
  createGateway,
  type FetchLike,
  type Gateway,
  type GatewayPurpose,
  type GatewayRequest,
  type GatewayResult,
  type ModelRole,
} from "./index";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

// K-01 v1's sample manifest gives the bundle id and the two model ids.
const manifest = readJson("contracts/bundle/fixtures/manifest.json") as {
  bundleId: BundleId;
  models: { haiku: string; sonnet: string };
};
const BUNDLE = { bundleId: manifest.bundleId, models: manifest.models };

// An obviously fake key, long enough to be found anywhere it leaks.
const KEY = "sk-ant-api03-FAKE-KEY-FOR-TESTS-ONLY-0123456789";
const ENV = { [KEY_VARIABLE]: KEY };

type Raw = Record<string, unknown>;

type Behavior =
  | { kind: "ok"; output: unknown; usage?: Raw; stop?: string }
  | { kind: "text"; text: string }
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "throw"; message: string };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Raw;
  model: string;
}

const everySeen: Seen[] = [];
const globalFetch = vi.fn(() => {
  throw new Error("no network in a gateway test: the global fetch was called");
});

const USAGE: Raw = {
  input_tokens: 120,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function answer(behavior: Behavior, signal: AbortSignal | null | undefined): Promise<Response> {
  switch (behavior.kind) {
    case "ok":
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            stop_reason: behavior.stop ?? "end_turn",
            content: [{ type: "text", text: JSON.stringify(behavior.output) }],
            usage: behavior.usage ?? USAGE,
          }),
          { status: 200 },
        ),
      );
    case "text":
      return Promise.resolve(
        new Response(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: behavior.text }],
            usage: USAGE,
          }),
          { status: 200 },
        ),
      );
    case "status":
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: KEY } }), { status: behavior.status }),
      );
    case "throw":
      return Promise.reject(new Error(behavior.message));
    case "hang":
      // Settles only when the gateway aborts it, as a real fetch does.
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
  }
}

/** A fake Messages API: `behave` decides each call's answer from what was sent and how many came before. */
function fakeApi(behave: (seen: Seen, n: number) => Behavior): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFake: FetchLike = (url, init) => {
    const body = JSON.parse(init.body as string) as Raw;
    const entry: Seen = {
      url,
      headers: init.headers as Record<string, string>,
      body,
      model: body.model as string,
    };
    seen.push(entry);
    everySeen.push(entry);
    return answer(behave(entry, seen.length - 1), init.signal);
  };
  return { fetch: fetchFake, seen };
}

/** The same answer every time, from the model that is asked, or per model. */
const always =
  (behavior: Behavior): ((seen: Seen) => Behavior) =>
  () =>
    behavior;
const SCHEMA: JsonObject = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

function request(
  purpose: GatewayPurpose,
  role: ModelRole,
  extra: Partial<GatewayRequest> = {},
): GatewayRequest {
  return {
    purpose,
    role,
    system: "You read one turn.",
    user: "A made-up turn text.",
    schema: SCHEMA,
    ...extra,
  };
}

function gatewayOver(api: { fetch: FetchLike }, env: Record<string, string | undefined> = ENV): Gateway {
  return createGateway({ bundle: BUNDLE, env, fetch: api.fetch });
}

const failures = (result: GatewayResult) => result.failures.map((failure) => failure.code);
const modelsOf = (seen: Seen[]) => seen.map((entry) => entry.model);

beforeAll(() => {
  vi.stubGlobal("fetch", globalFetch);
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T18:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  // Whatever a test did, no call went to another place or another model.
  for (const entry of everySeen) {
    expect(entry.url).toBe(API_URL);
    expect(ALLOWED_MODELS as readonly string[]).toContain(entry.model);
  }
  everySeen.length = 0;
});

describe("a call that works", () => {
  it("sends one request to the Messages endpoint with the key in its header, and returns the parsed output", async () => {
    const api = fakeApi(always({ kind: "ok", output: { ok: true } }));
    const result = await gatewayOver(api).call(
      request("decideFirst", "haiku", { maxTokens: 900, effort: "medium" }),
    );

    expect(result).toMatchObject({
      status: "ok",
      purpose: "decideFirst",
      output: { ok: true },
      model: HAIKU_MODEL,
      role: "haiku",
      attempt: 1,
      fallback: false,
      failures: [],
    });
    expect(api.seen).toHaveLength(1);
    const [sent] = api.seen;
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": API_VERSION,
    });
    // The request's own words go as given: the gateway changes no prompt and no schema.
    expect(sent?.body).toEqual({
      model: HAIKU_MODEL,
      max_tokens: 900,
      system: "You read one turn.",
      messages: [{ role: "user", content: "A made-up turn text." }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    });
  });

  it("asks for 4096 tokens and low effort when the request says nothing, and sends no sampling parameter", async () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    await gatewayOver(api).call(request("compose", "haiku"));
    const body = api.seen[0]?.body ?? {};
    expect(body.max_tokens).toBe(4096);
    expect((body.output_config as Raw).effort).toBe("low");
    for (const name of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(name);
  });

  it("calls the model the bundle names for the role: Sonnet for a Sonnet read", async () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    const result = await gatewayOver(api).call(request("reread", "sonnet"));
    expect(modelsOf(api.seen)).toEqual([SONNET_MODEL]);
    expect(result).toMatchObject({ status: "ok", role: "sonnet", model: SONNET_MODEL });
  });

  it("passes an answer from the recorded-model double through unchanged", async () => {
    const recorded = await loadRecordedModel();
    const context = readJson("contracts/model/fixtures/context-two-requests.json") as JsonObject;
    const read = await recorded.decide({ context, role: "first" });
    const api = fakeApi(always({ kind: "ok", output: read }));
    const result = await gatewayOver(api).call(request("decideFirst", "haiku"));
    expect(result.status === "ok" && result.output).toEqual(read);
  });
});

describe("timeouts: twice the stage's upper budget, on a fake clock", () => {
  it("has decide at 8 s, the re-read at 12 s, the composer at 6 s and the planner at 12 s (NQ-AI-1)", () => {
    expect(STAGE_TIMEOUT_MS).toEqual({ decide: 8000, reread: 12000, composer: 6000, planner: 12000 });
    expect(Object.fromEntries(GATEWAY_PURPOSES.map((purpose) => [purpose, STAGE_OF[purpose]]))).toEqual({
      decideFirst: "decide",
      decideCheck: "decide",
      reread: "reread",
      planner: "planner",
      compose: "composer",
      rewrite: "composer",
    });
  });

  it("retries a Haiku decide call that times out at 8 s once, then calls Sonnet once", async () => {
    const api = fakeApi((seen) =>
      seen.model === HAIKU_MODEL ? { kind: "hang" } : { kind: "ok", output: { ok: true } },
    );
    const pending = gatewayOver(api).call(request("decideFirst", "haiku"));

    await vi.advanceTimersByTimeAsync(7999);
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL]);
    await vi.advanceTimersByTimeAsync(1);
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL, HAIKU_MODEL]);
    await vi.advanceTimersByTimeAsync(7999);
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL, HAIKU_MODEL]);
    await vi.advanceTimersByTimeAsync(1);

    const result = await pending;
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL, HAIKU_MODEL, SONNET_MODEL]);
    expect(result).toMatchObject({ status: "ok", model: SONNET_MODEL, attempt: 3, fallback: true });
    expect(failures(result)).toEqual(["timeout", "timeout"]);
    expect(result.modelCalls.map((call) => [call.model, call.outcome, call.ms])).toEqual([
      [HAIKU_MODEL, "timedOut", 8000],
      [HAIKU_MODEL, "timedOut", 8000],
      [SONNET_MODEL, "ok", 0],
    ]);
  });

  it("falls back from Sonnet to Haiku the same way", async () => {
    const api = fakeApi((seen) =>
      seen.model === SONNET_MODEL ? { kind: "hang" } : { kind: "ok", output: { ok: true } },
    );
    const pending = gatewayOver(api).call(request("decideFirst", "sonnet"));
    await vi.advanceTimersByTimeAsync(16000);
    const result = await pending;
    expect(modelsOf(api.seen)).toEqual([SONNET_MODEL, SONNET_MODEL, HAIKU_MODEL]);
    expect(result).toMatchObject({ status: "ok", model: HAIKU_MODEL, role: "haiku", fallback: true });
  });

  it("gives up with modelsDown when all three attempts hang: three timeouts, never a fourth call", async () => {
    const api = fakeApi(always({ kind: "hang" }));
    const pending = gatewayOver(api).call(request("decideFirst", "haiku"));
    await vi.advanceTimersByTimeAsync(24000);
    const result = await pending;
    expect(result.status).toBe("modelsDown");
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL, HAIKU_MODEL, SONNET_MODEL]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(api.seen).toHaveLength(3);
  });

  for (const purpose of GATEWAY_PURPOSES) {
    const limit = STAGE_TIMEOUT_MS[STAGE_OF[purpose]];
    it(`${purpose}: each attempt times out at exactly ${String(limit)} ms, and not before`, async () => {
      const api = fakeApi(always({ kind: "hang" }));
      const pending = gatewayOver(api).call(request(purpose, "haiku"));

      await vi.advanceTimersByTimeAsync(limit - 1);
      expect(api.seen).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.seen).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(limit - 1);
      expect(api.seen).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.seen).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(limit);

      const result = await pending;
      expect(result.status).toBe("modelsDown");
      expect(result.modelCalls.map((call) => [call.outcome, call.ms])).toEqual([
        ["timedOut", limit],
        ["timedOut", limit],
        ["timedOut", limit],
      ]);
    });
  }

  it("times out a fetch that ignores its abort signal just as well", async () => {
    const stubborn: FetchLike = () => new Promise<Response>(() => undefined);
    const gateway = createGateway({ bundle: BUNDLE, env: ENV, fetch: stubborn });
    const pending = gateway.call(request("compose", "haiku"));
    await vi.advanceTimersByTimeAsync(18000);
    const result = await pending;
    expect(result.status).toBe("modelsDown");
    expect(failures(result)).toEqual(["timeout", "timeout", "timeout"]);
  });
});

describe("one retry, then the other model once, then models down", () => {
  it("answers on the retry with the same model when the first try fails", async () => {
    const api = fakeApi((_seen, n) =>
      n === 0 ? { kind: "status", status: 529 } : { kind: "ok", output: { ok: 1 } },
    );
    const result = await gatewayOver(api).call(request("decideFirst", "haiku"));
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL, HAIKU_MODEL]);
    expect(result).toMatchObject({ status: "ok", attempt: 2, fallback: false, model: HAIKU_MODEL });
    expect(failures(result)).toEqual(["http_529"]);
  });

  it("turns three failing attempts into modelsDown, naming each failure", async () => {
    const api = fakeApi(always({ kind: "status", status: 500 }));
    const result = await gatewayOver(api).call(request("decideFirst", "haiku"));
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL, HAIKU_MODEL, SONNET_MODEL]);
    expect(result).toEqual({
      status: "modelsDown",
      purpose: "decideFirst",
      modelCalls: expect.any(Array) as unknown,
      failures: [
        { model: HAIKU_MODEL, role: "haiku", attempt: 1, code: "http_500" },
        { model: HAIKU_MODEL, role: "haiku", attempt: 2, code: "http_500" },
        { model: SONNET_MODEL, role: "sonnet", attempt: 3, code: "http_500" },
      ],
    });
    expect(result.modelCalls.map((call) => call.outcome)).toEqual(["failed", "failed", "failed"]);
  });

  it("goes Sonnet, Sonnet, Haiku for a Sonnet-first call", async () => {
    const api = fakeApi(always({ kind: "status", status: 503 }));
    const result = await gatewayOver(api).call(request("reread", "sonnet"));
    expect(modelsOf(api.seen)).toEqual([SONNET_MODEL, SONNET_MODEL, HAIKU_MODEL]);
    expect(result.status).toBe("modelsDown");
  });

  it("counts a refusal as a failed call: the other model answers it", async () => {
    const api = fakeApi((seen) =>
      seen.model === HAIKU_MODEL
        ? { kind: "ok", output: { not: "a read" }, stop: "refusal", usage: { ...USAGE, output_tokens: 7 } }
        : { kind: "ok", output: { ok: true } },
    );
    const result = await gatewayOver(api).call(request("decideFirst", "haiku"));
    expect(failures(result)).toEqual(["refusal", "refusal"]);
    expect(result).toMatchObject({ status: "ok", model: SONNET_MODEL, output: { ok: true } });
    // A refused call still cost tokens, and says so.
    expect(result.modelCalls[0]).toMatchObject({ outcome: "failed", output_tokens: 7 });
    expect(result.modelCalls[0]?.cost_micro_usd).toBeGreaterThan(0);
  });

  it("checks stop_reason before parsing: a cut-off output is a failed call even when it parses", async () => {
    const api = fakeApi(always({ kind: "ok", output: { ok: true }, stop: "max_tokens" }));
    const result = await gatewayOver(api).call(request("planner", "sonnet"));
    expect(result.status).toBe("modelsDown");
    expect(failures(result)).toEqual(["max_tokens", "max_tokens", "max_tokens"]);
  });

  it("counts any stop but end_turn as a failed call", async () => {
    const api = fakeApi(always({ kind: "ok", output: { ok: true }, stop: "tool_use" }));
    const result = await gatewayOver(api).call(request("compose", "haiku"));
    expect(failures(result)).toEqual(["bad_stop", "bad_stop", "bad_stop"]);
  });

  it("counts a 429, a dropped connection and text that is not JSON as failed calls", async () => {
    const script: Behavior[] = [
      { kind: "status", status: 429 },
      { kind: "throw", message: "socket hang up" },
      { kind: "text", text: "Sorry, here is no JSON." },
    ];
    const api = fakeApi((_seen, n) => script[n] ?? { kind: "ok", output: {} });
    const result = await gatewayOver(api).call(request("decideCheck", "haiku"));
    expect(failures(result)).toEqual(["http_429", "network", "bad_output"]);
    expect(result.status).toBe("modelsDown");
  });

  it("keeps the calls of one batch apart: a stage-2 call retries and falls back on its own", async () => {
    // Three calls side by side, as decide's stage 2 sends one per part (CQ-25): part 2 fails twice on Haiku.
    const api = fakeApi((seen) => {
      const part = seen.body.messages as { content: string }[];
      const which = part[0]?.content ?? "";
      if (which.includes("part 2") && seen.model === HAIKU_MODEL) return { kind: "status", status: 500 };
      return { kind: "ok", output: { part: which } };
    });
    const gateway = gatewayOver(api);
    const results = await Promise.all(
      [1, 2, 3].map((n) => gateway.call(request("decideFirst", "haiku", { user: `part ${String(n)}` }))),
    );
    expect(results.map((r) => (r.status === "ok" ? [r.attempt, r.model] : null))).toEqual([
      [1, HAIKU_MODEL],
      [3, SONNET_MODEL],
      [1, HAIKU_MODEL],
    ]);
    expect(results.map((r) => (r.status === "ok" ? r.output : null))).toEqual([
      { part: "part 1" },
      { part: "part 2" },
      { part: "part 3" },
    ]);
    expect(api.seen).toHaveLength(5);
  });
});

describe("spans: one K-08 v1 span per attempt", () => {
  function traced(): ReturnType<typeof openTrace> {
    return openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE.bundleId,
      handleRef: "handle-sam",
      incomingTraceId: "6f1f4f0e-8c0a-4a77-9d36-2f5c3a1b9d10",
    });
  }

  it("writes a valid span for each attempt, with provider, call, attempt and the model call's fields", async () => {
    const trace = traced();
    const usage = {
      input_tokens: 1400,
      output_tokens: 160,
      cache_read_input_tokens: 5200,
      cache_creation_input_tokens: 0,
    };
    const api = fakeApi((seen) =>
      seen.model === SONNET_MODEL
        ? { kind: "ok", output: { ok: true }, usage }
        : { kind: "status", status: 529 },
    );
    const result = await gatewayOver(api).call(request("decideFirst", "haiku"), {
      trace,
      businessId: "biz-lees-barbershop",
      eventId: "evt-sam-0042",
    });
    expect(result.status).toBe("ok");

    const spans = trace.spans;
    expect(
      spans.map((span) => [span.hop, span.provider, span.call, span.attempt, span.outcome, span.error_code]),
    ).toEqual([
      ["portCall", "anthropic", "messages", 1, "failed", "http_529"],
      ["portCall", "anthropic", "messages", 2, "failed", "http_529"],
      ["portCall", "anthropic", "messages", 3, "ok", null],
    ]);
    for (const span of spans) {
      expect(spanProblems(span)).toEqual([]);
      expect(schemaErrors("span", span)).toEqual([]);
      expect(span.bundle_id).toEqual(BUNDLE.bundleId);
      expect(span.business_id).toBe("biz-lees-barbershop");
      expect(span.event_id).toBe("evt-sam-0042");
      expect(span.model_calls).toHaveLength(1);
    }
    expect(schemaErrors("trace", trace.toTrace())).toEqual([]);

    // The answering call, field for field: tokens as the API reported them, cost from the price list.
    expect(spans[2]?.model_calls?.[0]).toEqual({
      model: SONNET_MODEL,
      role: "sonnet",
      purpose: "decideFirst",
      input_tokens: 1400,
      cached_tokens: 5200,
      cache_write_tokens: 0,
      output_tokens: 160,
      // 1400 x $2 + 5200 x $0.20 + 160 x $10, per million tokens: 2800 + 1040 + 1600 micro-dollars.
      cost_micro_usd: 5440,
      ms: 0,
      outcome: "ok",
    });
    expect(result.modelCalls[2]).toEqual(spans[2]?.model_calls?.[0]);
  });

  it("records the time a call took as the span's ms and the model call's ms, and a timeout as timedOut", async () => {
    const trace = traced();
    const api = fakeApi(always({ kind: "hang" }));
    const pending = gatewayOver(api).call(request("rewrite", "haiku"), { trace });
    await vi.advanceTimersByTimeAsync(18000);
    await pending;
    expect(
      trace.spans.map((span) => [span.ms, span.outcome, span.error_code, span.model_calls?.[0]?.ms]),
    ).toEqual([
      [6000, "timedOut", "timeout", 6000],
      [6000, "timedOut", "timeout", 6000],
      [6000, "timedOut", "timeout", 6000],
    ]);
    expect(trace.spans.map((span) => span.at)).toEqual([
      "2026-11-07T18:00:00.000Z",
      "2026-11-07T18:00:06.000Z",
      "2026-11-07T18:00:12.000Z",
    ]);
    for (const span of trace.spans) expect(schemaErrors("span", span)).toEqual([]);
  });

  it("has exactly the fields trace-model-call-cost.json's model calls have, with the same kinds of value", async () => {
    const fixture = eventTraceFixture("trace-model-call-cost.json") as { spans: Span[] };
    const fixtureCalls = fixture.spans.flatMap((span) => span.model_calls ?? []);
    expect(fixtureCalls.length).toBeGreaterThan(0);

    const trace = traced();
    const api = fakeApi(
      always({ kind: "ok", output: {}, usage: { ...USAGE, cache_creation_input_tokens: 2600 } }),
    );
    for (const purpose of GATEWAY_PURPOSES)
      await gatewayOver(api).call(request(purpose, purpose === "planner" ? "sonnet" : "haiku"), { trace });
    const mine = trace.spans.flatMap((span) => span.model_calls ?? []);
    expect(mine).toHaveLength(GATEWAY_PURPOSES.length);

    const shape = (call: object): [string, string][] =>
      Object.entries(call)
        .map(([name, value]): [string, string] => [name, typeof value])
        .sort(([a], [b]) => a.localeCompare(b));
    for (const call of mine) expect(shape(call)).toEqual(shape(fixtureCalls[0] ?? {}));
    // The purposes it writes are among the fixture's, or the contract's own list.
    expect(new Set(mine.map((call) => call.purpose))).toEqual(new Set(GATEWAY_PURPOSES));
    expect(mine.find((call) => call.purpose === "compose")?.cache_write_tokens).toBe(2600);
  });

  it("holds no message words: not the request's, not the answer's, not a provider's error text", async () => {
    const trace = traced();
    const words = "block thursday afternoon and tile is twelve a foot";
    const reply = "Done: Thursday afternoon is blocked for Sam";
    const api = fakeApi((_seen, n) =>
      n === 0 ? { kind: "status", status: 500 } : { kind: "ok", output: { words: reply } },
    );
    const result = await gatewayOver(api).call(
      request("compose", "haiku", { system: `Rules. ${words}`, user: words }),
      { trace },
    );
    expect(result.status).toBe("ok");
    const everything = JSON.stringify([trace.toTrace(), result.modelCalls, result.failures]);
    for (const piece of [words, "thursday", "Thursday", "tile", "Sam", reply, "Rules"]) {
      expect(everything).not.toContain(piece);
    }
  });

  it("writes nothing when no trace is given, and refuses a trace of another bundle before any call", async () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    await expect(gatewayOver(api).call(request("compose", "haiku"))).resolves.toMatchObject({ status: "ok" });

    const other = openTrace({
      openedBy: "textWebhook",
      bundleId: { hash: "a".repeat(64), build: 1 },
      handleRef: "handle-sam",
    });
    const before = api.seen.length;
    await expect(gatewayOver(api).call(request("compose", "haiku"), { trace: other })).rejects.toThrow(
      GatewayConfigError,
    );
    expect(api.seen).toHaveLength(before);
    expect(other.spans).toHaveLength(0);
  });
});

describe("cost", () => {
  it("prices input, cache reads, cache writes and output apart, in whole micro-dollars", () => {
    expect(
      costMicroUsd(HAIKU_MODEL, {
        inputTokens: 320,
        cachedTokens: 1800,
        cacheWriteTokens: 0,
        outputTokens: 40,
      }),
    ).toBe(70);
    expect(
      costMicroUsd(HAIKU_MODEL, {
        inputTokens: 700,
        cachedTokens: 0,
        cacheWriteTokens: 2600,
        outputTokens: 180,
      }),
    ).toBe(485);
    expect(
      costMicroUsd(SONNET_MODEL, {
        inputTokens: 1000000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(2000000);
    expect(
      costMicroUsd(SONNET_MODEL, { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }),
    ).toBe(0);
  });

  it("has a price for exactly the two models, and says it is not yet confirmed by the CTO (NQ-AI-2)", () => {
    expect(Object.keys(PRICE_LIST.models).sort()).toEqual([HAIKU_MODEL, SONNET_MODEL]);
    expect(PRICE_LIST.confirmedByCto).toBe(false);
    expect(PRICE_LIST.readOn).toBe("2026-11-07");
    expect(() =>
      costMicroUsd("claude-opus-4-1", {
        inputTokens: 1,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("no model outside claude-haiku-5-5 and claude-sonnet-5-5 can be called", () => {
  it("allows exactly those two ids", () => {
    expect(ALLOWED_MODELS).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(BUNDLE.models).toEqual({ haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5" });
  });

  it("refuses a bundle that names any other id, and swapped ids, before it can make a call", () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    for (const models of [
      { haiku: "claude-opus-4-1", sonnet: SONNET_MODEL },
      { haiku: HAIKU_MODEL, sonnet: "gpt-5" },
      { haiku: SONNET_MODEL, sonnet: HAIKU_MODEL },
      { haiku: "deepinfra/meta-llama", sonnet: SONNET_MODEL },
    ]) {
      expect(() => createGateway({ bundle: { ...BUNDLE, models }, env: ENV, fetch: api.fetch })).toThrow(
        GatewayConfigError,
      );
    }
    expect(api.seen).toHaveLength(0);
  });

  it("refuses a bundle id that is not K-01's", () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    expect(() =>
      createGateway({
        bundle: { ...BUNDLE, bundleId: { hash: "nope", build: 0 } },
        env: ENV,
        fetch: api.fetch,
      }),
    ).toThrow(GatewayConfigError);
  });

  it("takes the model from the bundle, never from the request, even if a request carries a model field", async () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    const sneaky = { ...request("compose", "haiku"), model: "claude-opus-4-1" } as GatewayRequest;
    await gatewayOver(api).call(sneaky);
    expect(modelsOf(api.seen)).toEqual([HAIKU_MODEL]);
  });

  it("calls only api.anthropic.com's Messages endpoint, whatever fails", async () => {
    const api = fakeApi(always({ kind: "status", status: 500 }));
    await gatewayOver(api).call(request("decideFirst", "haiku"));
    expect(api.seen.map((entry) => entry.url)).toEqual([API_URL, API_URL, API_URL]);
    expect(API_URL).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.stringify(api.seen).toLowerCase()).not.toContain("deepinfra");
  });

  it("does not carry the safety read: it has its own path, and no call is made", async () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    const unfit = { ...request("compose", "haiku"), purpose: "safetyRead" } as unknown as GatewayRequest;
    await expect(gatewayOver(api).call(unfit)).rejects.toThrow(NotForTheGatewayError);
    expect(api.seen).toHaveLength(0);
  });
});

describe("the key", () => {
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;

  it("is read from ANTHROPIC_API_KEY in the environment it is given, at the moment of each call", async () => {
    expect(KEY_VARIABLE).toBe("ANTHROPIC_API_KEY");
    const env: Record<string, string | undefined> = {};
    const api = fakeApi(always({ kind: "ok", output: {} }));
    const gateway = gatewayOver(api, env);
    await expect(gateway.call(request("compose", "haiku"))).rejects.toThrow(MissingKeyError);
    env[KEY_VARIABLE] = KEY;
    await gateway.call(request("compose", "haiku"));
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("is named, never shown, when it is missing or empty, and no call is made", async () => {
    const api = fakeApi(always({ kind: "ok", output: {} }));
    for (const env of [{}, { [KEY_VARIABLE]: "" }, { OTHER_KEY: KEY }]) {
      const error = await gatewayOver(api, env)
        .call(request("compose", "haiku"))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(MissingKeyError);
      expect((error as MissingKeyError).message).toContain("ANTHROPIC_API_KEY");
      expect((error as MissingKeyError).message).not.toContain(KEY);
    }
    expect(api.seen).toHaveLength(0);
  });

  it("appears in no result, span, error or console line, even when the fake API echoes it everywhere", async () => {
    const spies = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const trace = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE.bundleId, handleRef: "handle-sam" });
    // A 500 whose body holds the key, a throw whose message holds it, a refusal whose text holds it, a model that
    // answers a key-bearing text.
    const script: Behavior[] = [
      { kind: "status", status: 500 },
      { kind: "throw", message: `connection to ${KEY} failed` },
      { kind: "ok", output: { echo: KEY }, stop: "refusal" },
      { kind: "text", text: KEY },
      { kind: "status", status: 502 },
      { kind: "status", status: 503 },
    ];
    const api = fakeApi((_seen, n) => script[n] ?? { kind: "ok", output: {} });
    const gateway = gatewayOver(api);
    const first = await gateway.call(request("decideFirst", "haiku"), { trace });
    const second = await gateway.call(request("reread", "sonnet"), { trace });
    expect(first.status).toBe("modelsDown");
    expect(second.status).toBe("modelsDown");

    const everything = JSON.stringify([first, second, trace.toTrace()]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("FAKE-KEY");
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("FAKE-KEY");
      spy.mockRestore();
    }
    // It went only where it belongs: the x-api-key header of each request, and nowhere in a body.
    for (const entry of api.seen) {
      expect(entry.headers["x-api-key"]).toBe(KEY);
      expect(JSON.stringify(entry.body)).not.toContain("FAKE-KEY");
    }
  });
});
