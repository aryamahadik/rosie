// T-1408 (DL-809, the first live JOIN's root cause): every model call's fetch, made by workerd's own fetch inside the
// Workers runtime: the AI gateway's send (ai/src/gateway/gateway.ts: decide, the re-read, the planner and the composer)
// and the safety wire's exchange (ai/src/safety/wire.ts: the safety read).
//
// Why. On staging (deploy 42) the JOIN's safety read made its two model calls, Haiku then Sonnet, and both failed at once
// as `network`, in 0 ms: both functions passed `redirect: "error"`, which workerd's fetch refuses with a TypeError before
// it sends anything ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the
// response status code), and both caught that throw as `network`. Every earlier test answered the model calls through a
// double at the fetch seam, so workerd's fetch never saw the option. Here workerd's fetch builds and sends each request.
//
// How the calls are carried. The Workers pool (@cloudflare/vitest-plugin 1.6.0) gives a test no interception of the
// global fetch: its cloudflare:test exports no fetchMock, its runner leaves the global fetch as workerd made it, and the
// pool's Miniflare options (vitest.config.ts) name no outboundService. So this file uses the closest form: the global
// fetch hands each call, with the url and every option the code gave it, to workerd's own fetch on a local service
// binding, the pool's loopback to this Worker's default entrypoint (`exports.default` from cloudflare:workers), whose fetch
// handler stands in for api.anthropic.com while this file runs. workerd's fetch is the same on a service binding as on the
// global outbound, the channel aside: it builds the Request from the url and options (where it refuses "error"), sends it,
// applies the redirect mode to the answer (under "follow" it asks for a 3xx's Location, through the same binding) and
// hands the answer back. Nothing leaves the Mac: the stand-in runs in this isolate, and the global fetch reaches nothing
// else. The code under test is not touched: each call goes through its own default path to the global fetch (the
// gateway's own, and the safety wire's as the Worker's ../src/wiring/staging/options.ts hands it).
//
// What it shows:
//   - workerd refuses `redirect: "error"` as it builds a request, with the TypeError staging met, and takes "manual";
//   - a 200 Messages answer is read as today (the gateway's ok result, the exchange's ok answer, the output parsed), and
//     each request arrived as the code made it: a POST to api.anthropic.com/v1/messages, the key in x-api-key, the
//     version and content type, the body as written;
//   - a 301, 302, 303, 307 or 308 is a failure labelled by its status (`http_<status>`: the gateway's three attempts end
//     in modelsDown, the exchange's one answer fails), and no request goes to its Location, so the key goes to
//     Anthropic's address alone. The stand-in answers the Location with a 200, so a redirect followed would succeed;
//   - a redirect workerd follows does reach the stand-in: with "follow" the same binding asks for the Location, so the
//     check above can fail.
// On today's main (`redirect: "error"`) the 200 and 3xx cases fail: workerd refuses each request, and each call comes
// back `network` with nothing sent.
//
// No live model call (J-02; DL-027): the key is made up for this file, and no request goes anywhere but the stand-in.
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_URL,
  API_VERSION,
  DEFAULT_MAX_TOKENS,
  HAIKU_MODEL,
  KEY_VARIABLE,
  SONNET_MODEL,
  createGateway,
  type FetchLike,
  type Gateway,
  type GatewayRequest,
} from "../../ai/src/gateway/index";
import { SAFETY_TRY_MS } from "../../ai/src/safety/read";
import { NO_USAGE, exchange } from "../../ai/src/safety/wire";
import manifest from "../../contracts/bundle/fixtures/manifest.json";
import worker from "../src/index";

/** The model key of this file: made up for the run, never Anthropic's. */
const MODEL_KEY = `t1408-made-up-model-key-${crypto.randomUUID()}`;

/** Where each redirect points: an address under the reserved example domain (RFC 2606), never Anthropic's. */
const LOCATION = "https://elsewhere.example/v1/messages";

/** The Fetch standard's five redirect statuses. */
const REDIRECTS = [301, 302, 303, 307, 308] as const;

/** This Worker's default entrypoint through the pool's loopback service binding: workerd's own fetch, on a local channel. */
const loopback = (exports as unknown as { readonly default: Fetcher }).default;

/** The global fetch while a test runs: each call handed on, as the code made it, to workerd's fetch on that binding. */
const viaWorkerd = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  loopback.fetch(input, init);

/** The safety wire's fetch, as the Worker hands it (../src/wiring/staging/options.ts): the global fetch, at each call. */
const globalFetch: FetchLike = (url, init) => fetch(url, init);

// ---- the stand-in for api.anthropic.com -------------------------------------------------------------------------------

/** One request as it reached the stand-in. */
interface Arrived {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly version: string | null;
  readonly contentType: string | null;
  /** The body, parsed; null for none (a GET, as a 301, 302 or 303 followed sends). */
  readonly body: unknown;
}

/** What the stand-in answers at the Messages endpoint for the test that runs. */
type Answer =
  | { readonly kind: "messages"; readonly output: unknown }
  | { readonly kind: "redirect"; readonly status: (typeof REDIRECTS)[number] };

/** The model's output each 200 at the Messages endpoint carries. */
const OUTPUT = { ok: true };
/** The output the Location's 200 carries: a redirect followed would come back with it. */
const FOLLOWED = { followed: true };

const USAGE = {
  input_tokens: 40,
  output_tokens: 60,
  cache_read_input_tokens: 1800,
  cache_creation_input_tokens: 0,
};

/** Every request the stand-in got in the test that runs, in order. */
const ARRIVED: Arrived[] = [];
let answer: Answer = { kind: "messages", output: OUTPUT };

/** A Messages API answer that ends its turn with this output as its one text block. */
function messagesAnswer(output: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "msg_t1408",
      type: "message",
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(output) }],
      usage: USAGE,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * The stand-in, in place of this Worker's own fetch handler while a test runs: it keeps each request it gets and answers
 * the Messages endpoint as the test says, the Location with a 200, and anything else with a 404.
 */
async function standIn(request: Request): Promise<Response> {
  const text = await request.text();
  ARRIVED.push({
    url: request.url,
    method: request.method,
    key: request.headers.get("x-api-key"),
    version: request.headers.get("anthropic-version"),
    contentType: request.headers.get("content-type"),
    body: text === "" ? null : JSON.parse(text),
  });
  if (request.url === API_URL) {
    return answer.kind === "messages"
      ? messagesAnswer(answer.output)
      : Response.redirect(LOCATION, answer.status);
  }
  if (request.url === LOCATION) return messagesAnswer(FOLLOWED);
  return new Response(null, { status: 404 });
}

beforeEach(() => {
  ARRIVED.length = 0;
  answer = { kind: "messages", output: OUTPUT };
  vi.spyOn(worker, "fetch").mockImplementation(standIn);
  vi.stubGlobal("fetch", viaWorkerd);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- the calls --------------------------------------------------------------------------------------------------------

/** The AI gateway over K-01's sample bundle, with no fetch of its own: it calls the global fetch, as the Worker's does. */
function gateway(): Gateway {
  return createGateway({
    bundle: { bundleId: manifest.bundleId, models: manifest.models },
    env: { [KEY_VARIABLE]: MODEL_KEY },
  });
}

/** A decide read, Haiku first: the JOIN turn's first model call through the gateway. */
const DECIDE: GatewayRequest = {
  purpose: "decideFirst",
  role: "haiku",
  system: "You read one turn.",
  user: "A made-up turn text.",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};

/** The body the gateway writes for that read on a model. */
const decideBody = (model: string): Record<string, unknown> => ({
  model,
  max_tokens: DEFAULT_MAX_TOKENS,
  system: DECIDE.system,
  messages: [{ role: "user", content: DECIDE.user }],
  output_config: { effort: "low", format: { type: "json_schema", schema: DECIDE.schema } },
});

/** A safety read's body on Haiku, as the safety read writes one (its own words are not this file's matter). */
const SAFETY_BODY = {
  model: HAIKU_MODEL,
  max_tokens: DEFAULT_MAX_TOKENS,
  messages: [{ role: "user", content: '<text source="text">A made-up text.</text>' }],
};

/** One safety wire exchange, through the global fetch, inside the safety read's own 2 s. */
const exchangeOnce = (): ReturnType<typeof exchange> =>
  exchange(globalFetch, MODEL_KEY, JSON.stringify(SAFETY_BODY), SAFETY_TRY_MS);

/** What a request the code made must be when it arrives: a POST to the Messages endpoint with the key and version. */
const sent = (body: unknown): Arrived => ({
  url: API_URL,
  method: "POST",
  key: MODEL_KEY,
  version: API_VERSION,
  contentType: "application/json",
  body,
});

// ---- the tests --------------------------------------------------------------------------------------------------------

describe("workerd's fetch and the redirect option", () => {
  it('refuses "error" as it builds a request, with the TypeError staging met, and takes "manual"', () => {
    const init: RequestInit = { method: "POST", body: JSON.stringify(SAFETY_BODY) };
    expect(() => new Request(API_URL, { ...init, redirect: "error" })).toThrow(TypeError);
    expect(() => new Request(API_URL, { ...init, redirect: "error" })).toThrow(/Invalid redirect value/u);
    expect(new Request(API_URL, { ...init, redirect: "manual" }).redirect).toBe("manual");
  });
});

describe("the AI gateway's send, through workerd's fetch", () => {
  it("reads a 200 Messages answer as today: one request, as the gateway made it, and the parsed output", async () => {
    const result = await gateway().call(DECIDE);

    expect(result).toMatchObject({
      status: "ok",
      purpose: "decideFirst",
      output: OUTPUT,
      model: HAIKU_MODEL,
      role: "haiku",
      attempt: 1,
      fallback: false,
      failures: [],
    });
    expect(result.modelCalls.map((call) => [call.model, call.outcome, call.input_tokens])).toEqual([
      [HAIKU_MODEL, "ok", 40],
    ]);
    expect(ARRIVED).toEqual([sent(decideBody(HAIKU_MODEL))]);
  });

  it.each(REDIRECTS)(
    "takes a %i answer as a failure labelled by its status on each of its three attempts, and never asks for its Location",
    async (status) => {
      answer = { kind: "redirect", status };
      const result = await gateway().call(DECIDE);

      const code = `http_${String(status)}`;
      expect(result.status).toBe("modelsDown");
      expect(result.failures).toEqual([
        { model: HAIKU_MODEL, role: "haiku", attempt: 1, code },
        { model: HAIKU_MODEL, role: "haiku", attempt: 2, code },
        { model: SONNET_MODEL, role: "sonnet", attempt: 3, code },
      ]);
      expect(result.modelCalls.map((call) => call.outcome)).toEqual(["failed", "failed", "failed"]);
      // Three requests, each to the Messages endpoint with the key; none to the Location.
      expect(ARRIVED).toEqual([
        sent(decideBody(HAIKU_MODEL)),
        sent(decideBody(HAIKU_MODEL)),
        sent(decideBody(SONNET_MODEL)),
      ]);
    },
  );
});

describe("the safety wire's exchange, through workerd's fetch", () => {
  it("reads a 200 Messages answer as today: one request, as the safety read sends it, and the parsed output", async () => {
    const answered = await exchangeOnce();

    expect(answered).toEqual({
      ok: true,
      output: OUTPUT,
      usage: { inputTokens: 40, cachedTokens: 1800, cacheWriteTokens: 0, outputTokens: 60 },
    });
    expect(ARRIVED).toEqual([sent(SAFETY_BODY)]);
  });

  it.each(REDIRECTS)(
    "takes a %i answer as a failure labelled by its status, and never asks for its Location",
    async (status) => {
      answer = { kind: "redirect", status };
      const answered = await exchangeOnce();

      expect(answered).toEqual({ ok: false, code: `http_${String(status)}`, usage: NO_USAGE });
      // One request, to the Messages endpoint with the key; none to the Location.
      expect(ARRIVED).toEqual([sent(SAFETY_BODY)]);
    },
  );
});

describe("the stand-in sees a redirect workerd follows", () => {
  it.each(REDIRECTS)(
    'a %i under "follow": the same binding asks for the Location, so the checks above would show one followed',
    async (status) => {
      answer = { kind: "redirect", status };
      const response = await loopback.fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(SAFETY_BODY),
        redirect: "follow",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stop_reason: "end_turn" });
      expect(ARRIVED.map((arrived) => arrived.url)).toEqual([API_URL, LOCATION]);
    },
  );
});
