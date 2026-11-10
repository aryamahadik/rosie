// The Worker's own routes, run inside the Workers runtime (Vitest project "workers"): the health endpoint and the 404,
// and web's pages, which the Worker serves last before its 404 (T-1192): the privacy notice T-1171 built, at
// {BASE_PATH}/privacy, with its headers as web sets them, while the Linq webhook, the page entry and the other routes
// before it answer as they did. The Worker gets wrangler.jsonc's staging vars (ENVIRONMENT "staging", BASE_PATH "/test")
// and GIT_SHA "test-sha" from vitest.config.ts. A reader's values are made up (rule 9): a documentation IP address and
// dummy tokens.
import { renderPrivacyPage } from "@rosie/web/src/pages/privacy/page";
import { contentSecurityPolicy, pageHeaders } from "@rosie/web/src/shell/serve";
import { createExecutionContext } from "cloudflare:test";
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

/** A reader's request headers as a browser could send them, made up (rule 9), with a valid trace id among them. */
const READER = {
  cookie: "session=dummy-session-token",
  "user-agent": "Mozilla/5.0 (made-up reader)",
  "x-forwarded-for": "203.0.113.7",
  referer: "https://example.invalid/from",
  "x-trace-id": TRACE_ID,
};

/** The headers web gives each page it serves (web/src/shell/serve.ts pageHeaders), as name and value pairs. */
const PAGE_HEADERS = [...pageHeaders("text/html; charset=utf-8")];

/** The Worker's answer to a request on `path`, under the Worker's vars `vars`: a page and the 404 answer at once. */
function send(path: string, init: RequestInit = {}, vars: Cloudflare.Env = env): Response {
  return worker.fetch(new Request(`https://rosie.test${path}`, init), vars);
}

/** The Worker's answer on a route that answers later (a webhook, a page call), through the runtime's own call. */
function sendLater(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(
    worker.fetch(new Request(`https://rosie.test${path}`, init), env, createExecutionContext()),
  );
}

/** Every header of an answer, as name and value pairs in the order Headers gives them. */
function headersOf(response: Response): [string, string][] {
  return [...response.headers];
}

describe("GET {BASE_PATH}/privacy: the Worker serves T-1171's privacy notice, last before its 404 (T-1192)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers GET /test/privacy with 200 and T-1171's page, its headers web's exactly: the page's CSP, no set-cookie, no trace id, and no log line", async () => {
    const logLines = captureLogLines();
    const response = send("/test/privacy", { headers: READER });

    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual(PAGE_HEADERS);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-trace-id")).toBe(false);
    expect(await response.text()).toBe(renderPrivacyPage("/test"));
    // Nothing about the reader is logged (web/src/shell/serve.ts), so a page writes no log line at all.
    expect(logLines()).toEqual([]);
  });

  it("sends a content security policy that loads nothing but the page's one inline style, by the hash workerd takes of the style served", async () => {
    captureLogLines();
    const response = send("/test/privacy");
    const html = await response.text();
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? "");
    expect(styles).toHaveLength(1);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(styles[0] ?? ""));
    const styleHash = btoa(String.fromCharCode(...new Uint8Array(digest)));

    expect(response.headers.get("content-security-policy")?.split("; ")).toEqual([
      "default-src 'none'",
      `style-src 'sha256-${styleHash}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
  });

  it("gives HEAD /test/privacy the page's headers and no body", async () => {
    captureLogLines();
    const response = send("/test/privacy", { method: "HEAD", headers: READER });

    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual(PAGE_HEADERS);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "answers %s /test/privacy with web's 405 (Allow: GET, HEAD), no set-cookie and no trace id",
    (method) => {
      captureLogLines();
      const response = send("/test/privacy", { method, headers: READER });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.has("x-trace-id")).toBe(false);
    },
  );

  it.each([
    "/test/privacy/",
    "/privacy",
    "/test/Privacy",
    "/test/privacy/more",
    "/test/privacy.html",
    "/test/test/privacy",
    "/testprivacy",
  ])("keeps %s on staging the Worker's 404 JSON with the trace id, for GET and POST alike", async (path) => {
    const logLines = captureLogLines();

    for (const method of ["GET", "POST"]) {
      const response = send(path, { method, headers: { "x-trace-id": TRACE_ID } });

      expect(response.status, method).toBe(404);
      expect(response.headers.get("x-trace-id"), method).toBe(TRACE_ID);
      expect(await response.json(), method).toEqual({ ok: false, error: "not_found", trace_id: TRACE_ID });
    }
    const notFound = {
      level: "info",
      msg: "not_found",
      trace_id: TRACE_ID,
      environment: "staging",
      version: "test-sha",
    };
    expect(logLines()).toEqual([notFound, notFound]);
  });

  it('follows env.BASE_PATH: with BASE_PATH "" (wrangler.jsonc\'s top level) the page is at /privacy, and /test/privacy is the 404', async () => {
    captureLogLines();
    const vars = { ...env, BASE_PATH: "" };

    const page = send("/privacy", {}, vars);
    const old = send("/test/privacy", { headers: { "x-trace-id": TRACE_ID } }, vars);

    expect(page.status).toBe(200);
    expect(headersOf(page)).toEqual(PAGE_HEADERS);
    expect(await page.text()).toBe(renderPrivacyPage(""));
    expect(old.status).toBe(404);
    expect(await old.json()).toEqual({ ok: false, error: "not_found", trace_id: TRACE_ID });
  });
});

describe("the routes before web's pages answer as they did (T-1192 adds the pages last, before the 404)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the Linq webhook: a POST takes the composition root's route, whose skeleton flag reads off with no release flags bound, so it answers its own 404 naming the flag", async () => {
    const logLines = captureLogLines();

    const response = await sendLater("/test/webhooks/linq", { method: "POST", body: "{}" });
    const traceId = response.headers.get("x-trace-id");

    expect(response.status).toBe(404);
    expect(traceId).toMatch(UUID);
    expect(await response.json()).toEqual({ ok: false, error: "not_found", trace_id: traceId });
    expect(logLines()).toEqual([
      {
        level: "info",
        msg: "not_found",
        trace_id: traceId,
        flag: "skeleton",
        environment: "staging",
        version: "test-sha",
      },
    ]);
  });

  it("the page entry: a K-21 call's POST reaches it, so a body that is not JSON gets the entry's own 400 with the trace id and a refused pageRequest span", async () => {
    const logLines = captureLogLines();

    const response = await sendLater("/test/page-api/signOut", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace-id": TRACE_ID },
      body: "not json at all",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response.json()).toEqual({ ok: false, error: "bad_request", trace_id: TRACE_ID });
    expect(logLines()).toContainEqual(
      expect.objectContaining({
        msg: "span",
        trace_id: TRACE_ID,
        hop: "pageRequest",
        got: { pageCall: "signOut" },
        outcome: "refused",
        error_code: "notJson",
      }),
    );
  });

  it.each([
    "/test/webhooks/linq",
    "/test/webhooks/stripe/rosfield",
    "/test/webhooks/stripe/businesses",
    "/test/webhooks/calendar/google",
    "/test/webhooks/calendar/microsoft",
    "/test/page-api/signOut",
  ])("a GET on %s is still that route's own 405 JSON with the trace id", async (path) => {
    captureLogLines();

    const response = await sendLater(path, { headers: { "x-trace-id": TRACE_ID } });

    expect(response.status).toBe(405);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response.json()).toEqual({ ok: false, error: "method_not_allowed", trace_id: TRACE_ID });
  });
});
