// The page entry, run inside the Workers runtime (T-266): the web app's K-21 v1 calls under BASE_PATH, each routed to
// its handler stub under a trace opened per request, the staging-only calls refused outside staging, and the 404 kept.
// The handlers are recording stubs (test-support.ts) that answer each fixture's own outcome; the Worker gets
// wrangler.jsonc's staging vars (ENVIRONMENT "staging", BASE_PATH "/test"), and a test that runs elsewhere changes them.
// Fixtures: every K-21 v1 fixture in contracts/page-api/fixtures/index.json, accepted and refused.
// T-1180: a body over the cap is answered 413 before it is read whole, with no stub run, and the span takes a handler's
// error only when it is one of K-21 v1's names; every fixture above still reaches its stub under the cap.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { createWorker } from "../../index";
import { unconfiguredGateway } from "..";
import { PAGE_BODY_LIMIT_BYTES } from "../body";
import { countedStream, postOf, xBytes } from "../test-support";
import type { GatewayDeps } from "../types";
import {
  PAGE_API_PATH,
  PAGE_CALLS,
  PAGE_ERRORS,
  STAGING_ONLY_CALLS,
  STAGING_ONLY_OUTCOME,
  UNKNOWN_PAGE_ERROR,
  isStagingOnly,
  pagePathOf,
  type PageCallName,
  type PageHandlers,
  type PageOutcome,
  type PageRequest,
} from ".";
import {
  captureLogLines,
  pagePost,
  pageSpans,
  recordingPages,
  stringsOf,
  v1Fixtures,
  type V1Fixture,
} from "./test-support";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE_ID = "6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const BUNDLE = { hash: "b".repeat(64), build: 2 };
const NOW = Date.parse("2026-11-10T09:00:00Z");

// The Worker never reads the context on these routes; the Workers runtime's own context has members this test cannot build.
const context = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const FIXTURES = v1Fixtures();
const ACCEPTED = FIXTURES.filter((fixture) => fixture.expect === "accept");
const REFUSED = FIXTURES.filter((fixture) => fixture.expect === "refuse");

/** A v1 fixture by its name in index.json. */
function fixture(file: string): V1Fixture {
  const found = FIXTURES.find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`no K-21 v1 fixture ${file}`);
  return found;
}

/** The gateway with these page handlers, a fixed bundle id and clock; every other door unconfigured. */
function gatewayWith(pages: PageHandlers, more: Partial<GatewayDeps> = {}): GatewayDeps {
  return { ...unconfiguredGateway(), pages, bundleId: () => BUNDLE, now: () => NOW, ...more };
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength;

/** A request as JSON, then trailing spaces (the same JSON) to exactly `bytes` bytes. */
function paddedTo(request: Record<string, unknown>, bytes: number): string {
  const json = JSON.stringify(request);
  if (bytesOf(json) > bytes) throw new Error(`the request is over ${String(bytes)} bytes already`);
  return json + " ".repeat(bytes - bytesOf(json));
}

/** The Worker's vars where a call runs: staging's as wrangler.jsonc sets them, or another ENVIRONMENT with BASE_PATH "". */
function envFor(environment: string): Cloudflare.Env {
  return environment === "staging" ? env : { ...env, ENVIRONMENT: environment, BASE_PATH: "" };
}

/** A call's path with the BASE_PATH of the environment it runs in. */
function pathIn(environment: string, call: PageCallName): string {
  return `${envFor(environment).BASE_PATH}${pagePathOf(call)}`;
}

/** Posts a fixture's request to its call's route, in the fixture's own environment, with a new trace id. */
async function postFixture(
  pages: PageHandlers,
  given: V1Fixture,
  environment: string = given.environment,
): Promise<{ response: Response; traceId: string }> {
  const traceId = crypto.randomUUID();
  const routed = createWorker(() => gatewayWith(pages));
  const response = await routed.fetch(
    pagePost(pathIn(environment, given.call), given.request, { traceId }),
    envFor(environment),
    context,
  );
  return { response, traceId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST {BASE_PATH}/page-api/<call>: every K-21 v1 fixture request reaches its handler stub", () => {
  it("covers every v1 fixture of index.json (35 accepted, 6 refused) and every call of K-21 v1", () => {
    expect(ACCEPTED).toHaveLength(35);
    expect(REFUSED).toHaveLength(6);
    expect(new Set(ACCEPTED.map((given) => given.call))).toEqual(new Set(PAGE_CALLS));
  });

  it("each accepted exchange reaches its call's stub at its route with its request as sent and the trace id; the answer is the stub's outcome, 200, with x-trace-id", async () => {
    captureLogLines();
    /** What the stubs answer: the outcome of the fixture being posted. */
    let answered: PageOutcome = {};
    const stubs = recordingPages(() => Promise.resolve(answered));
    const reached = new Set<PageCallName>();

    for (const given of ACCEPTED) {
      const refusedHere = isStagingOnly(given.call) && given.environment !== "staging";
      const before = stubs.calls.length;
      answered = given.outcome ?? {};

      const { response, traceId } = await postFixture(stubs.handlers, given);

      expect(response.status, given.file).toBe(200);
      expect(response.headers.get("x-trace-id"), given.file).toBe(traceId);
      expect(response.headers.get("content-type"), given.file).toBe("application/json; charset=utf-8");
      expect(await response.json(), given.file).toEqual(given.outcome);
      if (refusedHere) {
        // fire-now-in-production.json: the gateway answers stagingOnly itself, which is the fixture's outcome.
        expect(stubs.calls.length, given.file).toBe(before);
        expect(given.outcome, given.file).toEqual(STAGING_ONLY_OUTCOME);
      } else {
        expect(stubs.calls.slice(before), given.file).toEqual([
          {
            call: given.call,
            request: given.request,
            traceId,
            openedBy: "pageRequest",
            environment: given.environment,
          },
        ]);
        reached.add(given.call);
      }
    }

    expect(reached).toEqual(new Set(PAGE_CALLS));
  });

  it("each refused fixture: the two run in production are answered stagingOnly, never their refused outcome; the other four requests still reach their call's stub, whose checks they are", async () => {
    captureLogLines();

    for (const given of REFUSED) {
      const stubs = recordingPages(() => Promise.resolve({ result: "stub" }));

      const { response, traceId } = await postFixture(stubs.handlers, given);
      const body: unknown = await response.json();

      expect(response.status, given.file).toBe(200);
      expect(response.headers.get("x-trace-id"), given.file).toBe(traceId);
      if (given.environment === "production") {
        expect(isStagingOnly(given.call), given.file).toBe(true);
        expect(body, given.file).toEqual(STAGING_ONLY_OUTCOME);
        expect(body, given.file).not.toEqual(given.outcome);
        expect(stubs.calls, given.file).toEqual([]);
      } else {
        expect(body, given.file).toEqual({ result: "stub" });
        expect(stubs.calls, given.file).toEqual([
          {
            call: given.call,
            request: given.request,
            traceId,
            openedBy: "pageRequest",
            environment: "staging",
          },
        ]);
      }
    }
    expect(REFUSED.filter((given) => given.environment === "production").map((given) => given.file)).toEqual([
      "invalid/refuse-fire-now-in-production.json",
      "invalid/refuse-test-roster-in-production.json",
    ]);
  });
});

describe("the staging-only calls outside staging (refuse-fire-now-in-production.json)", () => {
  const fireNow = fixture("fire-now.json");
  const testPhoneSend = fixture("test-phone-send.json");
  const refused = fixture("invalid/refuse-fire-now-in-production.json");

  it.each(["production", "", "Staging", "staging ", "preview"])(
    "ENVIRONMENT %j: fire-now.json and test-phone-send.json answer stagingOnly with 200 and x-trace-id, no stub runs, and a refused pageRequest span",
    async (environment) => {
      const logLines = captureLogLines();
      const stubs = recordingPages();

      for (const given of [fireNow, testPhoneSend]) {
        const { response, traceId } = await postFixture(stubs.handlers, given, environment);

        expect(response.status, given.file).toBe(200);
        expect(response.headers.get("x-trace-id"), given.file).toBe(traceId);
        const body: unknown = await response.json();
        expect(body, given.file).toEqual(STAGING_ONLY_OUTCOME);
        expect(body, given.file).not.toEqual(refused.outcome);
      }

      expect(stubs.calls).toEqual([]);
      const spans = pageSpans(logLines());
      expect(spans).toHaveLength(2);
      for (const [place, call] of [
        [0, "fireNow"],
        [1, "testPhoneSend"],
      ] as const) {
        expect(spans[place]).toMatchObject({
          hop: "pageRequest",
          outcome: "refused",
          error_code: "stagingOnly",
          got: { pageCall: call },
          decided: { answered: 200, answer: "stagingOnly" },
          environment,
        });
      }
    },
  );

  it("refuses every staging-only call the same way in production, with the request of its own fixture", async () => {
    captureLogLines();
    const stubs = recordingPages();

    for (const call of STAGING_ONLY_CALLS) {
      const given = ACCEPTED.find(
        (candidate) => candidate.call === call && candidate.environment === "staging",
      );
      if (given === undefined) throw new Error(`no staging fixture of ${call}`);
      const { response } = await postFixture(stubs.handlers, given, "production");

      expect(await response.json(), call).toEqual(STAGING_ONLY_OUTCOME);
    }
    expect(stubs.calls).toEqual([]);
  });

  it("reads no body there: a staging-only call whose body is not JSON still answers stagingOnly", async () => {
    captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));

    const response = await routed.fetch(
      pagePost(pagePathOf("fireNow"), "not json at all"),
      envFor("production"),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(STAGING_ONLY_OUTCOME);
    expect(stubs.calls).toEqual([]);
  });

  it("refuses only the staging-only calls there: every other call still reaches its stub in production", async () => {
    captureLogLines();
    const stubs = recordingPages();

    for (const call of PAGE_CALLS.filter((name) => !isStagingOnly(name))) {
      const given = ACCEPTED.find((candidate) => candidate.call === call);
      if (given === undefined) throw new Error(`no fixture of ${call}`);
      const { response } = await postFixture(stubs.handlers, given, "production");

      expect(await response.json(), call).toEqual({ result: "stub" });
    }
    expect(stubs.calls.map((seen) => seen.call)).toEqual(PAGE_CALLS.filter((name) => !isStagingOnly(name)));
    expect(new Set(stubs.calls.map((seen) => seen.environment))).toEqual(new Set(["production"]));
  });
});

describe("one trace id per request", () => {
  it("keeps a valid incoming x-trace-id, in lower case, and hands the stub that trace, opened by pageRequest", async () => {
    captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));

    const response = await routed.fetch(
      pagePost("/test/page-api/openLink", fixture("open-link-secure-page.json").request, {
        traceId: TRACE_ID.toUpperCase(),
      }),
      env,
      context,
    );

    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(stubs.calls).toMatchObject([{ call: "openLink", traceId: TRACE_ID, openedBy: "pageRequest" }]);
  });

  it("opens a new UUID when none or no valid one comes, a different one per request, never the envelope's", async () => {
    captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));
    const given = fixture("test-phone-send.json");
    const seen: string[] = [];

    for (const incoming of [undefined, "", "not-a-trace-id", `${TRACE_ID}0`, "trace-page-tester-0002"]) {
      const response = await routed.fetch(
        pagePost("/test/page-api/testPhoneSend", given.request, {
          ...(incoming === undefined ? {} : { traceId: incoming }),
        }),
        env,
        context,
      );
      const traceId = response.headers.get("x-trace-id") ?? "";

      expect(traceId).toMatch(UUID);
      expect(stubs.calls.at(-1)?.traceId).toBe(traceId);
      seen.push(traceId);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("one pageRequest span per call, and no word of a request in any log line", () => {
  it("a response: one span with the trace id, the bundle id read at receipt, the call, the status and outcome ok", async () => {
    const logLines = captureLogLines();
    const given = fixture("test-phone-send.json");
    const stubs = recordingPages(() => Promise.resolve(given.outcome ?? {}));

    const { traceId } = await postFixture(stubs.handlers, given);

    const spans = pageSpans(logLines());
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      trace_id: traceId,
      seq: 1,
      hop: "pageRequest",
      bundle_id: BUNDLE,
      turn_id: null,
      handle_ref: null,
      got: { pageCall: "testPhoneSend" },
      decided: { answered: 200, answer: "response" },
      outcome: "ok",
      error_code: null,
      environment: "staging",
      version: "test-sha",
    });
  });

  it.each([
    ["signInNeeded", "refused"],
    ["notTester", "refused"],
    ["transient", "failed"],
    ["bookingPaused", "failed"],
  ])(
    "an outcome that is the call's %s error is sent as it is, and its span is %s",
    async (error, outcome) => {
      const logLines = captureLogLines();
      const stubs = recordingPages(() => Promise.resolve({ error }));

      const { response } = await postFixture(stubs.handlers, fixture("test-phone-parts.json"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ error });
      expect(pageSpans(logLines())[0]).toMatchObject({
        outcome,
        error_code: error,
        decided: { answered: 200, answer: error },
      });
    },
  );

  it("no string of any v1 fixture's request reaches a log line, whatever the answer", async () => {
    const logLines = captureLogLines();
    const answers: ((page: PageRequest) => Promise<PageOutcome>)[] = [
      () => Promise.resolve({ result: "stub" }),
      () => Promise.resolve({ error: "notAllowed" }),
      // A handler whose error quotes the request: only its name may be logged.
      (page) => Promise.reject(new Error(JSON.stringify(page.request))),
    ];

    for (const answer of answers) {
      const stubs = recordingPages(answer);
      for (const given of FIXTURES) {
        await postFixture(stubs.handlers, given);
        await postFixture(stubs.handlers, given, "production");
      }
    }

    const text = JSON.stringify(logLines());
    const words = new Set(
      FIXTURES.flatMap((given) => stringsOf(given.request)).filter((word) => word.length >= 8),
    );
    expect(words.size).toBeGreaterThan(50);
    for (const word of words) expect(text, word).not.toContain(word);
  });
});

describe("the edge's own answers", () => {
  it.each([
    ["not JSON", "not json at all", "notJson"],
    ["an empty body", "", "notJson"],
    ["a JSON array", "[1, 2]", "notAnObject"],
    ["a JSON string", '"text"', "notAnObject"],
    ["JSON null", "null", "notAnObject"],
  ])(
    "%s: 400 bad_request with the trace id, no stub runs, and a refused span naming why",
    async (_name, body, why) => {
      const logLines = captureLogLines();
      const stubs = recordingPages();
      const routed = createWorker(() => gatewayWith(stubs.handlers));

      const response = await routed.fetch(
        pagePost("/test/page-api/openLink", body, { traceId: TRACE_ID }),
        env,
        context,
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
      expect(await response.json()).toEqual({ ok: false, error: "bad_request", trace_id: TRACE_ID });
      expect(stubs.calls).toEqual([]);
      expect(pageSpans(logLines())).toMatchObject([
        { outcome: "refused", error_code: why, decided: { answered: 400 }, got: { pageCall: "openLink" } },
      ]);
    },
  );

  it("a handler that fails: 503 unavailable with the trace id, a failed span, and a log line with the error's name only", async () => {
    const logLines = captureLogLines();
    class SessionLookupError extends Error {
      override name = "SessionLookupError";
    }
    const stubs = recordingPages(() => Promise.reject(new SessionLookupError("placeholder words")));
    const routed = createWorker(() => gatewayWith(stubs.handlers));

    const response = await routed.fetch(
      pagePost("/test/page-api/signOut", fixture("sign-out.json").request, { traceId: TRACE_ID }),
      env,
      context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response.json()).toEqual({ ok: false, error: "unavailable", trace_id: TRACE_ID });
    const lines = logLines();
    expect(pageSpans(lines)).toMatchObject([
      { outcome: "failed", error_code: "handlerFailed", decided: { answered: 503 } },
    ]);
    expect(lines.filter((line) => line.msg === "gateway_failed")).toEqual([
      {
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE_ID,
        stage: "pageHandler",
        error: "SessionLookupError",
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("placeholder words");
  });

  it("a handler error whose name is not a label is logged as error", async () => {
    const logLines = captureLogLines();
    const thrown = new Error("x");
    thrown.name = "words from the page";
    const stubs = recordingPages(() => Promise.reject(thrown));

    const { response } = await postFixture(stubs.handlers, fixture("sign-out.json"));

    expect(response.status).toBe(503);
    expect(logLines().filter((line) => line.msg === "gateway_failed")).toMatchObject([{ error: "error" }]);
  });

  it.each([
    ["no outcome", undefined],
    ["a list", [{ result: "stub" }]],
    ["a string", "stub"],
    ["null", null],
  ])("a handler that answers %s: 503 unavailable, nothing of it sent", async (_name, outcome) => {
    const logLines = captureLogLines();
    const stubs = recordingPages(() => Promise.resolve(outcome as unknown as Record<string, unknown>));

    const { response, traceId } = await postFixture(stubs.handlers, fixture("sign-out.json"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "unavailable", trace_id: traceId });
    expect(pageSpans(logLines())).toMatchObject([{ outcome: "failed", error_code: "badHandlerAnswer" }]);
  });

  it.each(["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])(
    "%s on a call's path: 405 with the trace id, no stub runs",
    async (method) => {
      captureLogLines();
      const stubs = recordingPages();
      const routed = createWorker(() => gatewayWith(stubs.handlers));

      const response = await routed.fetch(
        pagePost("/test/page-api/fireNow", fixture("fire-now.json").request, { traceId: TRACE_ID, method }),
        env,
        context,
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
      if (method !== "HEAD") {
        expect(await response.json()).toEqual({ ok: false, error: "method_not_allowed", trace_id: TRACE_ID });
      }
      expect(stubs.calls).toEqual([]);
    },
  );

  it.each([
    "/test/page-api",
    "/test/page-api/",
    "/test/page-api/unknownCall",
    "/test/page-api/readListing",
    "/test/page-api/startBookingRequest",
    "/test/page-api/bookingConfirm",
    "/test/page-api/fireNow/",
    "/test/page-api/fireNow/extra",
    "/test/page-api/firenow",
    "/test/page-api/FireNow",
    "/test/page-api/fire%4Eow",
    "/test/page-api/constructor",
    "/test/page-api/__proto__",
    "/test/page-api/toString",
    "/test/pages/fireNow",
    "/test/api/page/fireNow",
    "/page-api/fireNow",
    "/test/test/page-api/fireNow",
  ])("an unknown path still answers the 404 JSON with the trace id: %s", async (path) => {
    const logLines = captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));

    const response = await routed.fetch(
      pagePost(path, fixture("fire-now.json").request, { traceId: TRACE_ID }),
      env,
      context,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response.json()).toEqual({ ok: false, error: "not_found", trace_id: TRACE_ID });
    expect(stubs.calls).toEqual([]);
    expect(pageSpans(logLines())).toEqual([]);
  });
});

describe("the body cap (T-1180): a body over it is answered 413 before it is read whole, and no stub runs", () => {
  /** The first staging fixture of each call: every call reads its body on staging. */
  const perCall = PAGE_CALLS.map((call) => {
    const given = ACCEPTED.find(
      (candidate) => candidate.call === call && candidate.environment === "staging",
    );
    if (given === undefined) throw new Error(`no staging fixture of ${call}`);
    return given;
  });

  it("a body one byte over the cap, on every call: 413 with the trace id, no stub runs, a refused span naming bodyTooLarge, nothing of the body logged", async () => {
    const logLines = captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));

    for (const given of perCall) {
      const traceId = crypto.randomUUID();
      const body = paddedTo(given.request, PAGE_BODY_LIMIT_BYTES + 1);
      expect(bytesOf(body), given.file).toBe(PAGE_BODY_LIMIT_BYTES + 1);

      const response = await routed.fetch(
        pagePost(pathIn("staging", given.call), body, { traceId }),
        env,
        context,
      );

      expect(response.status, given.file).toBe(413);
      expect(response.headers.get("x-trace-id"), given.file).toBe(traceId);
      expect(response.headers.get("content-type"), given.file).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control"), given.file).toBe("no-store");
      expect(await response.json(), given.file).toEqual({
        ok: false,
        error: "payload_too_large",
        trace_id: traceId,
      });
    }

    expect(stubs.calls).toEqual([]);
    const lines = logLines();
    const spans = pageSpans(lines);
    expect(spans.map((span) => (span.got as { pageCall: string }).pageCall)).toEqual([...PAGE_CALLS]);
    for (const span of spans) {
      expect(span).toMatchObject({
        outcome: "refused",
        error_code: "bodyTooLarge",
        decided: { answered: 413 },
      });
    }
    expect(lines).toHaveLength(PAGE_CALLS.length);
    const text = JSON.stringify(lines);
    for (const word of perCall
      .flatMap((given) => stringsOf(given.request))
      .filter((word) => word.length >= 8)) {
      expect(text, word).not.toContain(word);
    }
  });

  it("a body exactly at the cap still reaches its stub, with its request as sent", async () => {
    captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));
    const given = fixture("open-link-secure-page.json");

    const response = await routed.fetch(
      pagePost("/test/page-api/openLink", paddedTo(given.request, PAGE_BODY_LIMIT_BYTES), {
        traceId: TRACE_ID,
      }),
      env,
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "stub" });
    expect(stubs.calls).toEqual([
      {
        call: "openLink",
        request: given.request,
        traceId: TRACE_ID,
        openedBy: "pageRequest",
        environment: "staging",
      },
    ]);
  });

  it("counts bytes, not characters: a body under the cap in characters but one byte over it in UTF-8 is answered 413", async () => {
    captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));
    const given = fixture("open-link-secure-page.json");
    const room = PAGE_BODY_LIMIT_BYTES + 1 - bytesOf(JSON.stringify({ ...given.request, note: "" }));
    const pairs = Math.floor(room / 2);
    const body = JSON.stringify({ ...given.request, note: "é".repeat(pairs) }) + " ".repeat(room - 2 * pairs);
    expect(bytesOf(body)).toBe(PAGE_BODY_LIMIT_BYTES + 1);
    expect(body.length).toBeLessThan(PAGE_BODY_LIMIT_BYTES);

    const response = await routed.fetch(
      pagePost("/test/page-api/openLink", body, { traceId: TRACE_ID }),
      env,
      context,
    );

    expect(response.status).toBe(413);
    expect(stubs.calls).toEqual([]);
  });

  it("a declared length over the cap is answered 413 before a byte of the body is read", async () => {
    const logLines = captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));
    const source = countedStream(1024, () => xBytes(1024));

    const response = await routed.fetch(
      postOf(
        source.stream,
        {
          "content-type": "application/json",
          "content-length": String(PAGE_BODY_LIMIT_BYTES + 1),
          "x-trace-id": TRACE_ID,
        },
        "https://rosie.test/test/page-api/openLink",
      ),
      env,
      context,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large", trace_id: TRACE_ID });
    expect(source.pulled()).toBe(0);
    expect(stubs.calls).toEqual([]);
    expect(pageSpans(logLines())).toMatchObject([{ error_code: "bodyTooLarge", decided: { answered: 413 } }]);
  });

  it("a body that declares no length is cut off at the chunk that takes it over the cap: a 1 GiB body is never read whole", async () => {
    captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));
    const source = countedStream(1024 * 1024, () => xBytes(1024));

    const response = await routed.fetch(
      postOf(
        source.stream,
        { "content-type": "application/json", "x-trace-id": TRACE_ID },
        "https://rosie.test/test/page-api/openLink",
      ),
      env,
      context,
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(source.pulled()).toBeGreaterThan(PAGE_BODY_LIMIT_BYTES / 1024);
    expect(source.pulled()).toBeLessThan((2 * PAGE_BODY_LIMIT_BYTES) / 1024);
    expect(source.cancelled()).toBe(true);
    expect(stubs.calls).toEqual([]);
  });

  it("is a config value: GatewayDeps.pageBodyLimitBytes sets it, and a value that is not a whole number from 0 leaves the default", async () => {
    captureLogLines();
    const given = fixture("sign-out.json");
    const answers: number[] = [];

    for (const [limit, bytes] of [
      [1024, 1024],
      [1024, 1025],
      [Number.NaN, PAGE_BODY_LIMIT_BYTES],
      [-1, PAGE_BODY_LIMIT_BYTES + 1],
    ] as const) {
      const stubs = recordingPages();
      const routed = createWorker(() => gatewayWith(stubs.handlers, { pageBodyLimitBytes: limit }));
      const response = await routed.fetch(
        pagePost("/test/page-api/signOut", paddedTo(given.request, bytes)),
        env,
        context,
      );
      answers.push(response.status);
      expect(stubs.calls.length, `${String(limit)}: ${String(bytes)} bytes`).toBe(
        response.status === 200 ? 1 : 0,
      );
    }

    expect(answers).toEqual([200, 413, 200, 413]);
  });

  it("a staging-only call outside staging still answers stagingOnly, whatever its size: its body is never read", async () => {
    captureLogLines();
    const stubs = recordingPages();
    const routed = createWorker(() => gatewayWith(stubs.handlers));
    const source = countedStream(1024, () => xBytes(1024));

    const response = await routed.fetch(
      postOf(
        source.stream,
        { "content-type": "application/json" },
        `https://rosie.test${pagePathOf("fireNow")}`,
      ),
      envFor("production"),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(STAGING_ONLY_OUTCOME);
    expect(source.pulled()).toBe(0);
    expect(stubs.calls).toEqual([]);
  });
});

describe("the span takes a handler's error only when it is one of K-21 v1's names (T-1180)", () => {
  const FAILED = new Set(["transient", "bookingPaused"]);

  it.each([...PAGE_ERRORS])(
    "%s, a K-21 v1 error name: written in the span as itself, and the outcome sent as it is",
    async (error) => {
      const logLines = captureLogLines();
      const stubs = recordingPages(() => Promise.resolve({ error }));

      const { response, traceId } = await postFixture(stubs.handlers, fixture("sign-out.json"));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-trace-id")).toBe(traceId);
      expect(await response.json()).toEqual({ error });
      expect(pageSpans(logLines())).toMatchObject([
        {
          outcome: FAILED.has(error) ? "failed" : "refused",
          error_code: error,
          decided: { answered: 200, answer: error },
        },
      ]);
    },
  );

  it.each([
    ["a label K-21 v1 does not have", "notAK21Error"],
    ["the old fallback label", "error"],
    ["a K-21 name in another case", "LinkExpired"],
    ["a K-21 name with a space after it", "linkExpired "],
    ["a label shaped like an id", "handle.test-0001"],
    ["the gateway's own label", "bodyTooLarge"],
    ["words", "words from the page"],
    ["a number", 42],
    ["null", null],
    ["true", true],
    ["a list", ["linkExpired"]],
    ["an object", { name: "linkExpired" }],
  ])(
    "%s: written in the span as the fixed label unknownPageError, never itself, and the outcome still sent as it is",
    async (_name, error) => {
      const logLines = captureLogLines();
      const outcome = { error };
      const stubs = recordingPages(() => Promise.resolve(outcome));

      const { response } = await postFixture(stubs.handlers, fixture("sign-out.json"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(outcome);
      const lines = logLines();
      expect(pageSpans(lines)).toMatchObject([
        {
          outcome: "refused",
          error_code: UNKNOWN_PAGE_ERROR,
          decided: { answered: 200, answer: UNKNOWN_PAGE_ERROR },
        },
      ]);
      if (typeof error === "string") expect(JSON.stringify(lines)).not.toContain(`"${error}"`);
    },
  );
});

describe("the Worker as deployed (no page handler joined yet)", () => {
  it("routes every call to its not-connected stub: 503 with the trace id, and a failed span naming notConnected", async () => {
    const logLines = captureLogLines();

    for (const call of PAGE_CALLS) {
      const given = ACCEPTED.find(
        (candidate) => candidate.call === call && candidate.environment === "staging",
      );
      if (given === undefined) throw new Error(`no staging fixture of ${call}`);
      const traceId = crypto.randomUUID();

      const response = await worker.fetch(
        pagePost(`/test${PAGE_API_PATH}/${call}`, given.request, { traceId }),
        env,
        context,
      );

      expect(response.status, call).toBe(503);
      expect(response.headers.get("x-trace-id"), call).toBe(traceId);
      expect(await response.json(), call).toEqual({ ok: false, error: "unavailable", trace_id: traceId });
    }

    const spans = pageSpans(logLines());
    expect(spans.map((span) => (span.got as { pageCall: string }).pageCall)).toEqual([...PAGE_CALLS]);
    for (const span of spans) expect(span).toMatchObject({ outcome: "failed", error_code: "notConnected" });
  });

  it("answers fire-now.json and test-phone-send.json stagingOnly where ENVIRONMENT is production, with nothing joined", async () => {
    captureLogLines();

    for (const given of [fixture("fire-now.json"), fixture("test-phone-send.json")]) {
      const traceId = crypto.randomUUID();
      const response = await worker.fetch(
        pagePost(pagePathOf(given.call), given.request, { traceId }),
        envFor("production"),
        context,
      );

      expect(response.status, given.file).toBe(200);
      expect(response.headers.get("x-trace-id"), given.file).toBe(traceId);
      expect(await response.json(), given.file).toEqual(STAGING_ONLY_OUTCOME);
    }
  });

  it("keeps the health route and the 404 beside the page routes", async () => {
    captureLogLines();

    const health = await worker.fetch(pagePost("/test/health", {}, { method: "GET" }), env, context);
    const unknown = await worker.fetch(pagePost("/test/page-api/readListing", {}), env, context);

    expect(health.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-trace-id")).toMatch(UUID);
  });
});
