// Health endpoint tests, run inside the Workers runtime (Vitest project "workers"). The Worker gets wrangler.jsonc's
// staging vars and GIT_SHA "test-sha" from vitest.config.ts.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "./index";

const TRACE_ID = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function get(path: string, traceId?: string): Response {
  const headers = new Headers();
  if (traceId !== undefined) {
    headers.set("x-trace-id", traceId);
  }
  return worker.fetch(new Request(`https://rosie.test${path}`, { headers }), env);
}

/** Starts capturing console.log; the returned function gives the JSON log lines written so far. */
function captureLogLines(): () => unknown[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
}

describe("GET {BASE_PATH}/health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with ok, environment, version and the given trace id", async () => {
    captureLogLines();
    const response = get("/test/health", TRACE_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response.json()).toEqual({
      ok: true,
      service: "rosie",
      environment: "staging",
      version: "test-sha",
      trace_id: TRACE_ID,
    });
  });

  it("accepts a valid trace id in capitals and returns it in lower case", () => {
    captureLogLines();
    const response = get("/test/health", TRACE_ID.toUpperCase());

    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
  });

  it("makes a new trace id when none is given or the given one is not a valid id", async () => {
    captureLogLines();
    for (const given of [undefined, "", "not-a-trace-id", `${TRACE_ID}0`, "<script>"]) {
      const response = get("/test/health", given);
      const traceId = response.headers.get("x-trace-id");

      expect(response.status).toBe(200);
      expect(traceId).toMatch(UUID);
      expect(traceId).not.toBe(TRACE_ID);
      expect(await response.json()).toMatchObject({ trace_id: traceId });
    }
  });

  it("answers every other path with 404 JSON that carries the trace id", async () => {
    captureLogLines();
    for (const path of ["/health", "/test", "/test/health/extra", "/test/unknown"]) {
      const response = get(path, TRACE_ID);

      expect(response.status).toBe(404);
      expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
      expect(await response.json()).toEqual({ ok: false, error: "not_found", trace_id: TRACE_ID });
    }
  });

  it("writes one JSON log line per request, carrying the trace id", () => {
    const logLines = captureLogLines();
    get("/test/health", TRACE_ID);

    expect(logLines()).toEqual([
      { level: "info", msg: "health", trace_id: TRACE_ID, environment: "staging", version: "test-sha" },
    ]);
  });
});
