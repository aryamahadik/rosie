// Tests of the cache markers on the wire and through the AI gateway (T-364, C-122), replaying the recorded-model double's
// answers. No live call anywhere (J-02; CI makes none): every call goes to test-support's fake Messages API, which keeps
// Anthropic's prompt-cache rules, and the global fetch is stubbed to fail the file if anything reaches it. Cached tokens
// are read where the cost meter reads them: the gateway's K-08 portCall span of provider anthropic (CQ-36's default).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  API_URL,
  GatewayConfigError,
  HAIKU_MODEL,
  KEY_VARIABLE,
  NotForTheGatewayError,
  SONNET_MODEL,
  createGateway,
  type FetchLike,
  type GatewayBundle,
  type ModelCall,
} from "../gateway";
import { loadRecordedDouble, type JsonObject, type RecordedDouble } from "../recorded-double";
import { openTrace, spanProblems, type Span } from "../../../runtime/src/trace";
import { schemaErrors } from "../../../runtime/src/trace/test-support";
import {
  createCachedGateway,
  createPromptCache,
  sha256Hex,
  systemBlocks,
  systemText,
  toGatewayRequest,
  withCacheMarkers,
  type CacheBundle,
  type CachedPrompt,
  type PromptCache,
  type TurnContext,
} from "./index";
import { fakeCachingApi, fakeTokens, type FakeCachingApi } from "./test-support";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

interface Context extends TurnContext {
  choices: { choiceId: string; kind: string; label: string; definition: string }[];
  facts: { name: string; value: unknown }[];
  texts: { words: string }[];
}

const V0 = readJson("contracts/bundle/fixtures/bundle-v0-skeleton.json") as CacheBundle & {
  manifest: { models: GatewayBundle["models"] };
};
const S1_02 = readJson("contracts/model/fixtures/context-s1-02.json") as Context;
const PLANNER_ANSWER = readJson("ai/recordings/contexts/planner-answer.json") as Context;
const PLANNER_LOG_GAP = readJson("ai/recordings/contexts/planner-log-gap.json") as Context;
const COMPOSE_INPUTS = [
  readJson("contracts/message-plan/fixtures/input-s1-02.json"),
  readJson("ai/recordings/composer-inputs/block-readback-poll.json"),
] as JsonObject[];

// An obviously fake key, long enough to be found anywhere it leaks.
const KEY = "sk-ant-api03-FAKE-KEY-FOR-CACHE-TESTS-ONLY-0123456789";
const ENV = { [KEY_VARIABLE]: KEY };
const SCHEMA: JsonObject = {
  type: "object",
  properties: { language: { type: "string" } },
  required: ["language"],
  additionalProperties: false,
};

const gatewayBundle = (bundle: typeof V0): GatewayBundle => ({
  bundleId: bundle.manifest.bundleId,
  models: bundle.manifest.models,
});

/** The per-turn part as these tests write it; C-114 writes the real one. Reversed: a check read's other shuffle. */
function perTurn(context: Context, reversed = false): string {
  const choices = context.choices.map(
    (choice) => `${choice.choiceId}: ${choice.label}. ${choice.definition}`,
  );
  if (reversed) choices.reverse();
  const facts = context.facts.map((fact) => `${fact.name}: ${JSON.stringify(fact.value)}`);
  return `<choices>\n${choices.join("\n")}\n</choices>\n<facts>\n${facts.join("\n")}\n</facts>\n<turn>${context.texts.map((text) => text.words).join("\n")}</turn>`;
}

const rowOf = (input: JsonObject): string => `<input>${JSON.stringify(input)}</input>`;

const traceFor = (bundle: typeof V0): ReturnType<typeof openTrace> =>
  openTrace({ openedBy: "textWebhook", bundleId: bundle.manifest.bundleId, handleRef: "handle-sam" });

/** The model call of each span the gateway wrote: one per attempt. */
const callsOf = (spans: readonly Span[]): ModelCall[] => spans.flatMap((span) => span.model_calls ?? []);

/** Tokens of the prompt's cached segments, as the fake counts them (block by block). */
const cachedTokens = (prompt: CachedPrompt): number =>
  prompt.segments.reduce((sum, segment) => sum + fakeTokens(segment.text), 0);

function expectValidSpans(spans: readonly Span[]): void {
  for (const span of spans) {
    expect([span.hop, span.provider, span.call]).toEqual(["portCall", "anthropic", "messages"]);
    expect(spanProblems(span)).toEqual([]);
    expect(schemaErrors("span", span)).toEqual([]);
  }
}

const globalFetch = vi.fn(() => {
  throw new Error("no network in a cache test: the global fetch was called");
});
let double: RecordedDouble;
let cache: PromptCache;

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  double = await loadRecordedDouble();
  cache = createPromptCache(V0);
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("recorded-model double replay shows cached tokens on the second call's span", () => {
  it("decide: the first read writes the rules and the card; the check read, the second call, reads them, and its K-08 span shows it", async () => {
    const first = await double.decide({ context: S1_02 as unknown as JsonObject, role: "first" });
    const check = await double.decide({ context: S1_02 as unknown as JsonObject, role: "check" });
    const api = fakeCachingApi({ answer: (_body, n) => [first, check][n] });
    const gateway = createCachedGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: api.fetch });
    const trace = traceFor(V0);
    const firstPrompt = cache.forContext(S1_02, "decideFirst", perTurn(S1_02));
    const checkPrompt = cache.forContext(S1_02, "decideCheck", perTurn(S1_02, true));

    const firstResult = await gateway.call(firstPrompt, { role: "haiku", schema: SCHEMA }, { trace });
    const checkResult = await gateway.call(checkPrompt, { role: "haiku", schema: SCHEMA }, { trace });
    expect(firstResult).toMatchObject({ status: "ok", output: first, model: HAIKU_MODEL, attempt: 1 });
    expect(checkResult).toMatchObject({ status: "ok", output: check, model: HAIKU_MODEL, attempt: 1 });

    const prefix = cachedTokens(firstPrompt);
    expect(prefix).toBeGreaterThan(15000);
    expectValidSpans(trace.spans);
    expect(schemaErrors("trace", trace.toTrace())).toEqual([]);
    const [written, read] = callsOf(trace.spans);
    expect(written).toMatchObject({
      purpose: "decideFirst",
      cached_tokens: 0,
      cache_write_tokens: prefix,
      input_tokens: fakeTokens(firstPrompt.turn),
      outcome: "ok",
    });
    expect(read).toMatchObject({
      purpose: "decideCheck",
      cached_tokens: prefix,
      cache_write_tokens: 0,
      input_tokens: fakeTokens(checkPrompt.turn),
      outcome: "ok",
    });
    // A read costs a tenth of input and a write 1.25 times it (the gateway's price table): the second call is cheaper.
    expect(read?.cost_micro_usd ?? Infinity).toBeLessThan((written?.cost_micro_usd ?? 0) / 5);
    expect(checkResult.modelCalls).toEqual([read]);
  });

  it("the planner: two turns on one bundle id; the second turn's call reads the planner prompt and the rules", async () => {
    const answers = await Promise.all(
      [PLANNER_ANSWER, PLANNER_LOG_GAP].map((context) =>
        double.planner({ context: context as unknown as JsonObject }),
      ),
    );
    const api = fakeCachingApi({ answer: (_body, n) => answers[n] });
    const gateway = createCachedGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: api.fetch });
    const trace = traceFor(V0);
    const prompts = [PLANNER_ANSWER, PLANNER_LOG_GAP].map((context) =>
      cache.forContext(context, "planner", perTurn(context)),
    );
    for (const [n, prompt] of prompts.entries()) {
      const result = await gateway.call(prompt, { role: "sonnet", schema: SCHEMA }, { trace });
      expect(result).toMatchObject({ status: "ok", output: answers[n], model: SONNET_MODEL });
    }
    expectValidSpans(trace.spans);
    const [firstTurn] = prompts;
    if (firstTurn === undefined) throw new Error("two turns were laid out");
    const statics = cachedTokens(firstTurn);
    expect(
      callsOf(trace.spans).map((call) => [call.purpose, call.cached_tokens, call.cache_write_tokens]),
    ).toEqual([
      ["planner", 0, statics],
      ["planner", statics, 0],
    ]);
  });

  it("the composer: the second outbox row reads the system prompt once it is long enough; the sample prompt is under 512 tokens and is honestly not cached", async () => {
    const plans = await Promise.all(COMPOSE_INPUTS.map((input) => double.composer(input)));

    // The sample bundle's composer prompt is one sentence: under the minimum, so nothing is written or read.
    const sampleApi = fakeCachingApi({ answer: (_body, n) => plans[n] });
    const sampleGateway = createCachedGateway({
      bundle: gatewayBundle(V0),
      env: ENV,
      fetch: sampleApi.fetch,
    });
    const sampleTrace = traceFor(V0);
    for (const input of COMPOSE_INPUTS) {
      await sampleGateway.call(
        cache.layout({ purpose: "compose", turn: rowOf(input) }),
        { role: "haiku", schema: SCHEMA },
        { trace: sampleTrace },
      );
    }
    expect(fakeTokens(V0.manifest.prompts.composer.text)).toBeLessThan(512);
    expect(callsOf(sampleTrace.spans).map((call) => [call.cached_tokens, call.cache_write_tokens])).toEqual([
      [0, 0],
      [0, 0],
    ]);

    // A full-length system prompt (C-119 writes the real one): written by the first row, read by the second.
    const long = structuredClone(V0);
    const text = Array.from(
      { length: 60 },
      (_unused, k) =>
        `Style rule ${String(k + 1)}: keep each sentence short and plain, because people read it on a phone.`,
    ).join("\n");
    const prompts = long.manifest.prompts as unknown as Record<string, { text: string; sha256: string }>;
    prompts.composer = { ...prompts.composer, text, sha256: sha256Hex(text) };
    (long.manifest as { bundleId: { hash: string; build: number } }).bundleId = {
      hash: sha256Hex(text),
      build: 2,
    };
    const longCache = createPromptCache(long);
    const api = fakeCachingApi({ answer: (_body, n) => plans[n] });
    const gateway = createCachedGateway({ bundle: gatewayBundle(long), env: ENV, fetch: api.fetch });
    const trace = traceFor(long);
    for (const [n, input] of COMPOSE_INPUTS.entries()) {
      const result = await gateway.call(
        longCache.layout({ purpose: "compose", turn: rowOf(input) }),
        { role: "haiku", schema: SCHEMA },
        { trace },
      );
      expect(result).toMatchObject({ status: "ok", output: plans[n] });
    }
    expectValidSpans(trace.spans);
    expect(fakeTokens(text)).toBeGreaterThan(512);
    expect(
      callsOf(trace.spans).map((call) => [call.purpose, call.cached_tokens, call.cache_write_tokens]),
    ).toEqual([
      ["compose", 0, fakeTokens(text)],
      ["compose", fakeTokens(text), 0],
    ]);
  });

  it("the markers are what does it: the same two calls through the plain gateway, with no marker, cache nothing", async () => {
    const first = await double.decide({ context: S1_02 as unknown as JsonObject, role: "first" });
    const api = fakeCachingApi({ answer: () => first });
    const plain = createGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: api.fetch });
    const trace = traceFor(V0);
    for (const purpose of ["decideFirst", "decideCheck"] as const) {
      const prompt = cache.forContext(S1_02, purpose, perTurn(S1_02));
      await plain.call(toGatewayRequest(prompt, { role: "haiku", schema: SCHEMA }), { trace });
    }
    expect(api.calls.map((call) => call.markers)).toEqual([0, 0]);
    expect(callsOf(trace.spans).map((call) => [call.cached_tokens, call.cache_write_tokens])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("caches are per model: Haiku's entry is not read by the Sonnet fallback, which writes its own, read by the next Sonnet call", async () => {
    const first = await double.decide({ context: S1_02 as unknown as JsonObject, role: "first" });
    // Call 0 is Haiku; calls 1 and 2 (Haiku again, twice) fail with 529; call 3 is the Sonnet fallback; call 4 Sonnet.
    const api = fakeCachingApi({
      answer: () => first,
      fail: (_body, n) => (n === 1 || n === 2 ? 529 : null),
    });
    const gateway = createCachedGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: api.fetch });
    const trace = traceFor(V0);
    const prompt = cache.forContext(S1_02, "decideFirst", perTurn(S1_02));
    await gateway.call(prompt, { role: "haiku", schema: SCHEMA }, { trace });
    const fallback = await gateway.call(prompt, { role: "haiku", schema: SCHEMA }, { trace });
    await gateway.call(prompt, { role: "sonnet", schema: SCHEMA }, { trace });
    expect(fallback).toMatchObject({ status: "ok", model: SONNET_MODEL, fallback: true, attempt: 3 });
    expectValidSpans(trace.spans);
    const prefix = cachedTokens(prompt);
    expect(
      callsOf(trace.spans).map((call) => [
        call.model,
        call.outcome,
        call.cached_tokens,
        call.cache_write_tokens,
      ]),
    ).toEqual([
      [HAIKU_MODEL, "ok", 0, prefix],
      [HAIKU_MODEL, "failed", 0, 0],
      [HAIKU_MODEL, "failed", 0, 0],
      [SONNET_MODEL, "ok", 0, prefix],
      [SONNET_MODEL, "ok", prefix, 0],
    ]);
  });

  it("an entry lives 5 minutes from its last read: read at 4 and 8 minutes, gone after 5 idle minutes, then written again", async () => {
    const first = await double.decide({ context: S1_02 as unknown as JsonObject, role: "first" });
    let clock = Date.parse("2026-11-07T18:00:00Z");
    const api = fakeCachingApi({ answer: () => first, now: () => clock });
    const gateway = createCachedGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: api.fetch });
    const prompt = cache.forContext(S1_02, "decideFirst", perTurn(S1_02));
    const reads: [number, number][] = [];
    for (const minutes of [0, 4, 4, 6]) {
      clock += minutes * 60 * 1000;
      const result = await gateway.call(prompt, { role: "haiku", schema: SCHEMA });
      const call = result.modelCalls[0];
      reads.push([call?.cached_tokens ?? -1, call?.cache_write_tokens ?? -1]);
    }
    const prefix = cachedTokens(prompt);
    expect(reads).toEqual([
      [0, prefix],
      [prefix, 0],
      [prefix, 0],
      [0, prefix],
    ]);
  });
});

describe("cache markers ride the gateway's requests", () => {
  const prompt = (): CachedPrompt => cache.forContext(S1_02, "decideFirst", perTurn(S1_02));

  function capturing(api: FakeCachingApi): { fetch: FetchLike; seen: { url: string; init: RequestInit }[] } {
    const seen: { url: string; init: RequestInit }[] = [];
    return {
      fetch: (url, init) => {
        seen.push({ url, init });
        return api.fetch(url, init);
      },
      seen,
    };
  }

  it("sends the prompt's text as given, as marked system blocks, with the url, the key header and the rest of the body unchanged", async () => {
    const laidOut = prompt();
    const marked = capturing(fakeCachingApi({ answer: () => ({ language: "en" }) }));
    const plain = capturing(fakeCachingApi({ answer: () => ({ language: "en" }) }));
    const request = { role: "haiku", schema: SCHEMA, maxTokens: 900, effort: "medium" } as const;
    await createCachedGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: marked.fetch }).call(
      laidOut,
      request,
    );
    await createGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: plain.fetch }).call(
      toGatewayRequest(laidOut, request),
    );

    const [sent] = marked.seen;
    const [unmarked] = plain.seen;
    expect(sent?.url).toBe(API_URL);
    expect(sent?.init.headers).toEqual(unmarked?.init.headers);
    expect((sent?.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
      JSON.parse(typeof init?.body === "string" ? init.body : "null") as Record<string, unknown>;
    const body = bodyOf(sent?.init);
    const plainBody = bodyOf(unmarked?.init);
    expect(body.system).toEqual([
      { type: "text", text: laidOut.segments[0]?.text, cache_control: { type: "ephemeral" } },
      { type: "text", text: laidOut.segments[1]?.text, cache_control: { type: "ephemeral" } },
    ]);
    expect(plainBody.system).toBe(systemText(laidOut));
    expect({ ...body, system: systemText(laidOut) }).toEqual(plainBody);
    expect(Object.keys(body)).toEqual(Object.keys(plainBody));
    expect(body).toMatchObject({
      model: HAIKU_MODEL,
      max_tokens: 900,
      messages: [{ role: "user", content: laidOut.turn }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    });
    expect(JSON.stringify(body)).not.toContain("FAKE-KEY");
  });

  it("leaves any other request as it came: another system text, a body that is not JSON text, or not an object", () => {
    const laidOut = prompt();
    const other = { body: JSON.stringify({ system: "another prompt", messages: [] }) };
    expect(withCacheMarkers(other, laidOut)).toBe(other);
    for (const init of [
      {},
      { body: "not json" },
      { body: "[1, 2]" },
      { body: new Uint8Array([1]) },
    ] as RequestInit[]) {
      expect(withCacheMarkers(init, laidOut)).toBe(init);
    }
    const ours = {
      method: "POST",
      body: JSON.stringify({ model: HAIKU_MODEL, system: systemText(laidOut) }),
    };
    const out = withCacheMarkers(ours, laidOut);
    expect(out).toEqual({
      method: "POST",
      body: JSON.stringify({ model: HAIKU_MODEL, system: systemBlocks(laidOut) }),
    });
  });

  it("refuses, before any call, a prompt of another bundle and a safety read; and a bundle the gateway refuses", async () => {
    const api = fakeCachingApi({ answer: () => ({}) });
    const gateway = createCachedGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: api.fetch });
    const miniB = createPromptCache(readJson("contracts/bundle/fixtures/bundle-mini-b.json") as CacheBundle);
    await expect(
      gateway.call(miniB.layout({ purpose: "compose", turn: "a row" }), { role: "haiku", schema: SCHEMA }),
    ).rejects.toThrow(GatewayConfigError);
    await expect(
      gateway.call(cache.layout({ purpose: "safetyRead", turn: "a text" }), {
        role: "haiku",
        schema: SCHEMA,
      }),
    ).rejects.toThrow(NotForTheGatewayError);
    expect(api.calls).toHaveLength(0);
    expect(() =>
      createCachedGateway({
        bundle: { ...gatewayBundle(V0), models: { haiku: "claude-opus-4-1", sonnet: SONNET_MODEL } },
        env: ENV,
        fetch: api.fetch,
      }),
    ).toThrow(GatewayConfigError);
  });
});

describe("the fake Messages API keeps Anthropic's caching rules (so the replay above can be trusted)", () => {
  const blocks = (texts: string[], marked: number[], ttl?: string): unknown[] =>
    texts.map((text, index) => ({
      type: "text",
      text,
      ...(marked.includes(index) && {
        cache_control: ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl },
      }),
    }));
  const body = (system: unknown, extra: Record<string, unknown> = {}): RequestInit => ({
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 10,
      system,
      messages: [{ role: "user", content: "the turn" }],
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      ...extra,
    }),
  });
  const big = "rule ".repeat(1000);

  it("refuses more than 4 markers, and a longer lifetime after a shorter one", async () => {
    const api = fakeCachingApi({ answer: () => ({}) });
    const five = await api.fetch(API_URL, body(blocks(["a", "b", "c", "d", "e"], [0, 1, 2, 3, 4])));
    expect(five.status).toBe(400);
    const mixed = await api.fetch(
      API_URL,
      body([
        { type: "text", text: big, cache_control: { type: "ephemeral" } },
        { type: "text", text: big, cache_control: { type: "ephemeral", ttl: "1h" } },
      ]),
    );
    expect(mixed.status).toBe(400);
  });

  it("writes nothing under 512 tokens, and reads nothing for another schema, another effort or another text", async () => {
    const api = fakeCachingApi({ answer: () => ({}) });
    await api.fetch(API_URL, body(blocks(["short"], [0])));
    await api.fetch(API_URL, body(blocks([big], [0])));
    await api.fetch(
      API_URL,
      body(blocks([big], [0]), {
        output_config: { effort: "low", format: { type: "json_schema", schema: {} } },
      }),
    );
    await api.fetch(
      API_URL,
      body(blocks([big], [0]), {
        output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      }),
    );
    await api.fetch(API_URL, body(blocks([`${big}!`], [0])));
    await api.fetch(API_URL, body(blocks([big], [0])));
    expect(
      api.calls.map((call) => [call.usage?.cache_read_input_tokens, call.usage?.cache_creation_input_tokens]),
    ).toEqual([
      [0, 0],
      [0, fakeTokens(big)],
      [0, fakeTokens(big)],
      [0, fakeTokens(big)],
      [0, fakeTokens(`${big}!`)],
      [fakeTokens(big), 0],
    ]);
  });

  it("does not let calls sent side by side read each other's writes (an entry is readable once its response is back)", async () => {
    const api = fakeCachingApi({ answer: () => ({ language: "en" }) });
    const gateway = createCachedGateway({ bundle: gatewayBundle(V0), env: ENV, fetch: api.fetch });
    const laidOut = cache.forContext(S1_02, "decideFirst", perTurn(S1_02));
    const sideBySide = await Promise.all(
      [1, 2].map(() => gateway.call(laidOut, { role: "haiku", schema: SCHEMA })),
    );
    const after = await gateway.call(laidOut, { role: "haiku", schema: SCHEMA });
    const prefix = cachedTokens(laidOut);
    expect(
      [...sideBySide, after].map((result) => [
        result.modelCalls[0]?.cached_tokens,
        result.modelCalls[0]?.cache_write_tokens,
      ]),
    ).toEqual([
      [0, prefix],
      [0, prefix],
      [prefix, 0],
    ]);
  });
});
