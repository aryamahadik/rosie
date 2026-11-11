// The Worker's own routes, run inside the Workers runtime (Vitest project "workers"): the health endpoint and the 404,
// and web's pages, which the Worker serves last before its 404 (T-1192), through the web app shell (T-1234; T-511): the
// privacy notice T-1171 built, at {BASE_PATH}/privacy, as every shell page is served (web's headers, the request's
// trace id in x-trace-id, one log line), and the routes a feature folder lists, staging's test tools on staging only,
// with a page's K-21 calls reaching the page entry in process; while the Linq webhook, the page entry and the other
// routes before it answer as they did. The Worker gets wrangler.jsonc's staging vars (ENVIRONMENT "staging", BASE_PATH
// "/test", LINK_HOST "rosfield.com") and GIT_SHA "test-sha" from vitest.config.ts. A reader's values are made up (rule
// 9): a documentation IP address and dummy tokens. And the retry queue's entry (T-1223): a retry batch that is the
// first event an isolate sees wires the isolate first, as a request does, so its try runs at once and is never answered
// "unwired"; its ids are made up too.
import { ROUTES as authRoutes } from "@rosie/web/src/auth/routes";
import { PageApiError } from "@rosie/web/src/client/client";
import { renderPrivacyPage } from "@rosie/web/src/pages/privacy/page";
import { readWebConfig } from "@rosie/web/src/shell/config";
import { renderErrorPage } from "@rosie/web/src/shell/error-pages";
import type { RouteContext, RouteModule, ShellRoute } from "@rosie/web/src/shell/route";
import { contentSecurityPolicy, pageHeaders } from "@rosie/web/src/shell/serve";
import { createWebShell } from "@rosie/web/src/shell/shell";
import { createWebWorker } from "@rosie/web/src/shell/worker";
import { ROUTES as testPhoneSendRoutes } from "@rosie/web/src/staging/test-phone/send/routes";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unconfiguredGateway, unconfiguredPages, type PageHandlers, type PageRequest } from "./gateway";
import worker, { createWorker, type PageCallRoute, type RosieWorker, type WebPages } from "./index";
import { queueDeps, SEND_SPACING_S, type RetryMessage } from "./queues";
import { batchOf, fakeClock, fakeQueue, type FakeQueue } from "./queues/test-support";
import { unwireWorker, wiredRoot, workerRoot } from "./wiring";

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

/**
 * A shell page's headers (web/src/shell/shell.ts): web's page headers exactly, and the request's trace id beside them
 * (x-trace-id is the last name in the order Headers gives).
 */
function shellHeaders(traceId: string): [string, string][] {
  return [...PAGE_HEADERS, ["x-trace-id", traceId]];
}

/** The shell's one log line for a page answer (web/src/shell/shell.ts PageLogLine), with nothing else in it. */
function pageLine(traceId: string, route: string, status: number): Record<string, unknown> {
  return { level: status >= 500 ? "error" : "info", msg: "page", trace_id: traceId, route, status };
}

/** The Worker's answer to a request on `path`, under the Worker's vars `vars`: the 404 answer at once. */
function send(path: string, init: RequestInit = {}, vars: Cloudflare.Env = env): Response {
  return worker.fetch(new Request(`https://rosie.test${path}`, init), vars);
}

/**
 * The Worker's answer on a route that answers later (a webhook, a page call, one of web's pages), through the runtime's
 * own call, under the Worker's vars `vars`.
 */
function sendLater(path: string, init: RequestInit = {}, vars: Cloudflare.Env = env): Promise<Response> {
  return Promise.resolve(
    worker.fetch(new Request(`https://rosie.test${path}`, init), vars, createExecutionContext()),
  );
}

/** Every header of an answer, as name and value pairs in the order Headers gives them. */
function headersOf(response: Response): [string, string][] {
  return [...response.headers];
}

/** One answer as it was sent: its status, every header and its body's text. */
async function sentOf(
  response: Response,
): Promise<{ status: number; headers: [string, string][]; body: string }> {
  return { status: response.status, headers: headersOf(response), body: await response.text() };
}

// T-1234: the Worker now serves this page through the web shell, so it is served as every shell page is (CQ-209 (a)):
// with the request's trace id in x-trace-id and one log line, and a method the page does not take gets the shell's 405
// page. The assertions that said "no trace id, no log line" and the 405's plain text say that now; the rest is as it was.
describe("GET {BASE_PATH}/privacy: the Worker serves T-1171's privacy notice, last before its 404 (T-1192)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers GET /test/privacy with 200 and T-1171's page, as the shell serves every page: web's page headers exactly (the page's CSP, no set-cookie), the request's trace id in x-trace-id, and one log line holding nothing of the reader", async () => {
    const logLines = captureLogLines();
    const response = await sendLater("/test/privacy", { headers: READER });

    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual(shellHeaders(TRACE_ID));
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response.text()).toBe(renderPrivacyPage("/test"));
    // The shell's one line (CQ-209 (a)): the trace id, the route's fixed label and the status. Nothing about the reader
    // is logged: no cookie, user agent, address or referrer, and nothing of the request's own address.
    expect(logLines()).toEqual([pageLine(TRACE_ID, "privacy", 200)]);
    const written = JSON.stringify(logLines());
    for (const value of [
      "dummy-session-token",
      "Mozilla",
      "203.0.113.7",
      "example.invalid",
      "rosie.test",
      "/test/privacy",
    ])
      expect(written, value).not.toContain(value);
  });

  it("gives a request that brings no valid trace id a new one, the same in x-trace-id and in the log line", async () => {
    for (const given of [undefined, "not-a-trace-id", `${TRACE_ID}0`, "<script>"]) {
      const logLines = captureLogLines();
      const response = await sendLater(
        "/test/privacy",
        given === undefined ? {} : { headers: { "x-trace-id": given } },
      );
      const traceId = response.headers.get("x-trace-id") ?? "";

      expect(response.status).toBe(200);
      expect(traceId, given).toMatch(UUID);
      expect(traceId).not.toBe(TRACE_ID);
      expect(headersOf(response)).toEqual(shellHeaders(traceId));
      expect(logLines()).toEqual([pageLine(traceId, "privacy", 200)]);
      vi.restoreAllMocks();
    }
  });

  it("is the shell's own page: for GET, HEAD and a method the page does not take, the Worker's answer and log line are the ones createWebShell gives the same request under the same vars", async () => {
    const shellLines: string[] = [];
    const shell = createWebShell({
      config: readWebConfig(env),
      transport: { send: () => Promise.reject(new Error("the privacy notice makes no call")) },
      log: (line) => shellLines.push(line),
    });
    const logLines = captureLogLines();

    for (const method of ["GET", "HEAD", "POST"]) {
      const fromWorker = await sentOf(await sendLater("/test/privacy", { method, headers: READER }));
      const fromShell = await sentOf(
        await shell.fetch(new Request("https://rosie.test/test/privacy", { method, headers: READER })),
      );

      expect(fromWorker, method).toEqual(fromShell);
    }
    expect(shellLines).toHaveLength(3);
    expect(logLines()).toEqual(shellLines.map((line) => JSON.parse(line) as unknown));
  });

  it("sends a content security policy that loads nothing but the page's one inline style, by the hash workerd takes of the style served", async () => {
    captureLogLines();
    const response = await sendLater("/test/privacy");
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
    const logLines = captureLogLines();
    const response = await sendLater("/test/privacy", { method: "HEAD", headers: READER });

    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual(shellHeaders(TRACE_ID));
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
    expect(logLines()).toEqual([pageLine(TRACE_ID, "privacy", 200)]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "answers %s /test/privacy with the shell's 405 page (Allow: GET, HEAD), no set-cookie, the trace id and one log line",
    async (method) => {
      const logLines = captureLogLines();
      const response = await sendLater("/test/privacy", { method, headers: READER });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      // The shell's 405 is a page inside the frame, showing the trace id (web/src/shell/error-pages.ts), where
      // servePage's was plain text.
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
      expect(await response.text()).toBe(
        renderErrorPage({ status: 405, basePath: "/test", traceId: TRACE_ID }),
      );
      expect(logLines()).toEqual([pageLine(TRACE_ID, "privacy", 405)]);
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

    const page = await sendLater("/privacy", {}, vars);
    const old = send("/test/privacy", { headers: { "x-trace-id": TRACE_ID } }, vars);
    const pageTraceId = page.headers.get("x-trace-id") ?? "";

    expect(page.status).toBe(200);
    expect(pageTraceId).toMatch(UUID);
    expect(headersOf(page)).toEqual(shellHeaders(pageTraceId));
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

/** The headers of every JSON answer the Worker and its gateway give, in the order Headers gives them. */
function jsonHeaders(traceId: string): [string, string][] {
  return [
    ["cache-control", "no-store"],
    ["content-type", "application/json; charset=utf-8"],
    ["x-trace-id", traceId],
  ];
}

// T-1234: these answers were written down from the Worker as it was before it served the shell: this block was written
// first and passed against main's servePage Worker (16af5be; the card's first commit holds it alone), and the Worker
// that serves the shell must give the same bytes.
describe("health, the webhook doors, the page entry and the 404 answer as before the Worker served the shell, byte for byte (T-1234)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("health: the same status, headers, body and log line", async () => {
    const logLines = captureLogLines();

    expect(await sentOf(get("/test/health", TRACE_ID))).toEqual({
      status: 200,
      headers: jsonHeaders(TRACE_ID),
      body: `{"ok":true,"service":"rosie","environment":"staging","version":"test-sha","trace_id":"${TRACE_ID}"}`,
    });
    expect(logLines()).toEqual([
      { level: "info", msg: "health", trace_id: TRACE_ID, environment: "staging", version: "test-sha" },
    ]);
  });

  it.each(["GET", "POST", "HEAD"])(
    "the 404: %s on a path no route and no page takes gets the same status, headers, body and log line",
    async (method) => {
      const logLines = captureLogLines();

      const sent = await sentOf(send("/test/unknown", { method, headers: { ...READER } }));

      expect(sent).toEqual({
        status: 404,
        headers: jsonHeaders(TRACE_ID),
        body: `{"ok":false,"error":"not_found","trace_id":"${TRACE_ID}"}`,
      });
      expect(logLines()).toEqual([
        { level: "info", msg: "not_found", trace_id: TRACE_ID, environment: "staging", version: "test-sha" },
      ]);
    },
  );

  it.each([
    "/test/webhooks/linq",
    "/test/webhooks/resend",
    "/test/webhooks/stripe/rosfield",
    "/test/webhooks/stripe/businesses",
    "/test/webhooks/calendar/google",
    "/test/webhooks/calendar/microsoft",
    "/test/page-api/signOut",
    "/test/page-api/fireNow",
  ])("a GET on %s: that route's own 405, the same bytes, and no log line", async (path) => {
    const logLines = captureLogLines();

    const sent = await sentOf(await sendLater(path, { headers: { ...READER } }));

    expect(sent).toEqual({
      status: 405,
      headers: jsonHeaders(TRACE_ID),
      body: `{"ok":false,"error":"method_not_allowed","trace_id":"${TRACE_ID}"}`,
    });
    expect(logLines()).toEqual([]);
  });

  it.each([
    { path: "/test/webhooks/linq", status: 404, error: "not_found" },
    { path: "/test/webhooks/resend", status: 401, error: "unauthorized" },
    { path: "/test/webhooks/stripe/rosfield", status: 401, error: "unauthorized" },
    { path: "/test/webhooks/stripe/businesses", status: 401, error: "unauthorized" },
    { path: "/test/webhooks/calendar/google", status: 401, error: "unauthorized" },
    { path: "/test/webhooks/calendar/microsoft", status: 401, error: "unauthorized" },
  ])(
    "a POST on $path: the door's own $status, under a trace id of its own, the same bytes",
    async ({ path, status, error }) => {
      captureLogLines();

      const response = await sendLater(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trace-id": TRACE_ID },
        body: "{}",
      });
      const traceId = response.headers.get("x-trace-id") ?? "";

      // A webhook opens a trace id of its own (runtime/src/gateway/answer.ts): the one sent is never kept.
      expect(traceId).toMatch(UUID);
      expect(traceId).not.toBe(TRACE_ID);
      expect(await sentOf(response)).toEqual({
        status,
        headers: jsonHeaders(traceId),
        body: `{"ok":false,"error":"${error}","trace_id":"${traceId}"}`,
      });
    },
  );

  it.each([
    { name: "a body that is not JSON", body: "not json at all", status: 400, error: "bad_request" },
    { name: "a JSON body that is no object", body: "[1]", status: 400, error: "bad_request" },
    { name: "a call whose handler is not joined", body: "{}", status: 503, error: "unavailable" },
  ])(
    "the page entry, $name: its own $status under the trace id sent, the same bytes",
    async ({ body, status, error }) => {
      captureLogLines();

      const response = await sendLater("/test/page-api/signOut", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trace-id": TRACE_ID },
        body,
      });

      expect(await sentOf(response)).toEqual({
        status,
        headers: jsonHeaders(TRACE_ID),
        body: `{"ok":false,"error":"${error}","trace_id":"${TRACE_ID}"}`,
      });
    },
  );

  it("the page entry, a staging-only call where ENVIRONMENT is production: K-21's stagingOnly with 200, the same bytes", async () => {
    captureLogLines();
    const vars = { ...env, ENVIRONMENT: "production", BASE_PATH: "" };

    const response = await Promise.resolve(
      worker.fetch(
        new Request("https://rosie.test/page-api/fireNow", {
          method: "POST",
          headers: { "content-type": "application/json", "x-trace-id": TRACE_ID },
          body: "{}",
        }),
        vars,
        createExecutionContext(),
      ),
    );

    expect(await sentOf(response)).toEqual({
      status: 200,
      headers: jsonHeaders(TRACE_ID),
      body: '{"error":"stagingOnly"}',
    });
  });
});

/** What a made-up route does with its context: the test's own function, run as the route's handler. */
type Probe = (context: RouteContext) => Response | Promise<Response>;

/**
 * A made-up feature folder, as a page task lists its routes in its own routes.ts (web/README.md "Adding a page"): a
 * page, a :name path that knows one item, and a route that runs `probe`.
 */
function exampleModule(
  probe: Probe = (context) => context.page({ title: "Probe", main: "<h1>Probe</h1>" }),
): RouteModule {
  return {
    folder: "example",
    stagingOnly: false,
    routes: [
      {
        label: "example.hello",
        path: "/example/hello",
        methods: ["GET"],
        handle: (context) => context.page({ title: "Hello", main: "<h1>Hello</h1>" }),
      },
      {
        label: "example.item",
        path: "/example/items/:item",
        methods: ["GET"],
        handle: (context) =>
          context.params.item === "known-item"
            ? context.page({ title: "Item", main: "<h1>Item</h1>" })
            : context.notFound(),
      },
      { label: "example.probe", path: "/example/probe", methods: ["GET", "POST"], handle: probe },
    ],
  };
}

/** A made-up staging test tool's folder (build prompt 9.4), marked staging only; `runs` counts its handler's runs. */
function toolModule(runs: { count: number }): RouteModule {
  return {
    folder: "example/tool",
    stagingOnly: true,
    routes: [
      {
        label: "example.tool",
        path: "/example/tool",
        methods: ["GET", "POST"],
        handle: (context) => {
          runs.count += 1;
          return context.page({ title: "Tool", main: "<h1>Tool</h1>" });
        },
      },
    ],
  };
}

/**
 * A Worker that serves `web` in place of web's own lists, over the gateway's unconfigured doors with `pages` among its
 * page handlers (every other handler answers by failing, so its call answers 503).
 */
function workerOver(web: WebPages, pages: Partial<PageHandlers> = {}): RosieWorker {
  return createWorker(
    () => ({ ...unconfiguredGateway(), pages: { ...unconfiguredPages(), ...pages } }),
    () => null,
    undefined,
    web,
  );
}

/** That Worker's answer to a request on `path`, through the runtime's own call, under the Worker's vars `vars`. */
function ask(
  made: RosieWorker,
  path: string,
  init: RequestInit = {},
  vars: Cloudflare.Env = env,
): Promise<Response> {
  return Promise.resolve(
    made.fetch(new Request(`https://rosie.test${path}`, init), vars, createExecutionContext()),
  );
}

/** The pool's vars with some replaced; a value may be one the Worker's types do not allow (a var left out, or not a string). */
function varsWith(change: Record<string, unknown>): Cloudflare.Env {
  return { ...env, ...change };
}

/** The Worker's own 404 as it is sent, for an address no route and no page takes. */
function notFoundSent(traceId: string): { status: number; headers: [string, string][]; body: string } {
  return {
    status: 404,
    headers: jsonHeaders(traceId),
    body: `{"ok":false,"error":"not_found","trace_id":"${traceId}"}`,
  };
}

/** The Worker's own log line for that 404. */
function notFoundLine(traceId: string, environment = "staging"): Record<string, unknown> {
  return { level: "info", msg: "not_found", trace_id: traceId, environment, version: "test-sha" };
}

/** The plain 500 a page request gets when the shell gave it no answer (runtime/src/index.ts pageFailed), as it is sent. */
function pageFailedSent(traceId: string): { status: number; headers: [string, string][]; body: string } {
  return {
    status: 500,
    headers: [
      ["cache-control", "no-store"],
      ["content-type", "text/plain; charset=utf-8"],
      ["x-content-type-options", "nosniff"],
      ["x-trace-id", traceId],
    ],
    body: "The page could not be shown.\n",
  };
}

/** A transport for a shell whose pages make no call: any call fails the test's page. */
const NO_CALLS = { send: () => Promise.reject(new Error("this page makes no call")) };

describe("the Worker hands a page request to the web shell (T-1234): the shell's routes are served with no route of the Worker's own", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a feature folder's page as the shell does: inside the frame, with web's page headers, the trace id and one log line", async () => {
    const logLines = captureLogLines();
    const made = workerOver({ shell: { modules: [exampleModule()] } });

    const response = await ask(made, "/test/example/hello", { headers: READER });

    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual(shellHeaders(TRACE_ID));
    const html = await response.text();
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n')).toBe(true);
    expect(html).toContain('<main id="main" tabindex="-1">\n<h1>Hello</h1>\n</main>');
    expect(logLines()).toEqual([pageLine(TRACE_ID, "example.hello", 200)]);
  });

  it("gives every address a route takes the shell's own answer and log line, byte for byte: a static page, a feature page, its HEAD, a method it does not take, a :name path and a route's own 404", async () => {
    const modules = [exampleModule()];
    const shellLines: string[] = [];
    const shell = createWebShell({
      config: readWebConfig(env),
      transport: NO_CALLS,
      modules,
      log: (line) => shellLines.push(line),
    });
    const made = workerOver({ shell: { modules } });
    const logLines = captureLogLines();
    const asked = [
      { method: "GET", path: "/test/privacy" },
      { method: "GET", path: "/test/example/hello" },
      { method: "HEAD", path: "/test/example/hello" },
      { method: "POST", path: "/test/example/hello" },
      { method: "GET", path: "/test/example/items/known-item" },
      { method: "GET", path: "/test/example/items/dummy-item" },
      { method: "POST", path: "/test/example/probe" },
    ];

    for (const { method, path } of asked) {
      const fromWorker = await sentOf(await ask(made, path, { method, headers: READER }));
      const fromShell = await sentOf(
        await shell.fetch(new Request(`https://rosie.test${path}`, { method, headers: READER })),
      );

      expect(fromWorker, `${method} ${path}`).toEqual(fromShell);
    }
    expect(shellLines).toHaveLength(asked.length);
    expect(logLines()).toEqual(shellLines.map((line) => JSON.parse(line) as unknown));
  });

  it("an address under BASE_PATH that a route takes but that names nothing: the shell's 404 page, showing the trace id", async () => {
    const logLines = captureLogLines();
    const made = workerOver({ shell: { modules: [exampleModule()] } });

    const response = await ask(made, "/test/example/items/dummy-item", { headers: READER });

    expect(response.status).toBe(404);
    expect(headersOf(response)).toEqual(shellHeaders(TRACE_ID));
    expect(await response.text()).toBe(
      renderErrorPage({ status: 404, basePath: "/test", traceId: TRACE_ID }),
    );
    expect(logLines()).toEqual([pageLine(TRACE_ID, "example.item", 404)]);

    // With no trace id sent, the page shows the new one x-trace-id carries.
    const fresh = await ask(made, "/test/example/items/dummy-item");
    const traceId = fresh.headers.get("x-trace-id") ?? "";
    expect(traceId).toMatch(UUID);
    expect(await fresh.text()).toBe(renderErrorPage({ status: 404, basePath: "/test", traceId }));
  });

  it.each([
    "/test/example",
    "/test/example/unknown",
    "/test/example/items",
    "/test/example/items/known-item/more",
    "/test/example/hello/",
    "/test/Example/hello",
    "/example/hello",
    "/test/unknown",
    "/test/",
    "/test",
  ])(
    "an address no route of the shell takes (%s): the shell gives no answer, so the Worker's own 404 JSON answers with the trace id and its log line, byte for byte as before, for GET and POST alike",
    async (path) => {
      const logLines = captureLogLines();
      const made = workerOver({ shell: { modules: [exampleModule()] } });

      for (const method of ["GET", "POST"]) {
        const response = await ask(made, path, { method, headers: READER });

        expect(await sentOf(response), method).toEqual(notFoundSent(TRACE_ID));
      }
      // The Worker's line alone: the shell logs nothing for an address it does not take.
      expect(logLines()).toEqual([notFoundLine(TRACE_ID), notFoundLine(TRACE_ID)]);
    },
  );

  it("serves a staging-only folder's route where ENVIRONMENT is staging", async () => {
    const logLines = captureLogLines();
    const runs = { count: 0 };
    const made = workerOver({ shell: { modules: [toolModule(runs), exampleModule()] } });

    const response = await ask(made, "/test/example/tool", { headers: READER });

    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual(shellHeaders(TRACE_ID));
    expect(await response.text()).toContain("<h1>Tool</h1>");
    expect(runs.count).toBe(1);
    expect(logLines()).toEqual([pageLine(TRACE_ID, "example.tool", 200)]);
  });

  it.each(["production", "Staging", "staging ", "preview"])(
    'a staging-only route answers 404 where ENVIRONMENT is "%s": the Worker\'s own 404, as for any address no route takes, and its handler never runs',
    async (environment) => {
      for (const basePath of ["", "/test"]) {
        const logLines = captureLogLines();
        const runs = { count: 0 };
        const made = workerOver({ shell: { modules: [toolModule(runs), exampleModule()] } });
        const vars = varsWith({ ENVIRONMENT: environment, BASE_PATH: basePath });

        for (const method of ["GET", "POST", "HEAD"]) {
          const response = await ask(made, `${basePath}/example/tool`, { method, headers: READER }, vars);

          expect(await sentOf(response), `${method} ${basePath}`).toEqual(notFoundSent(TRACE_ID));
        }
        expect(runs.count).toBe(0);
        const notFound = notFoundLine(TRACE_ID, environment);
        expect(logLines()).toEqual([notFound, notFound, notFound]);
        // The folders that are not staging only are served there as everywhere.
        expect((await ask(made, `${basePath}/example/hello`, {}, vars)).status).toBe(200);
        vi.restoreAllMocks();
      }
    },
  );
});

describe("the Worker that is deployed serves web's own lists: a route a feature folder adds is served with no change to the Worker (T-1234; build prompt 3.5 (c))", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a route put in a folder's own ROUTES list (web/src/auth/routes.ts), which was the 404 before it was listed", async () => {
    const logLines = captureLogLines();
    const added: ShellRoute = {
      label: "example.added",
      path: "/example/added",
      methods: ["GET"],
      handle: (context) => context.page({ title: "Added", main: "<h1>Added</h1>" }),
    };
    // The list the folder exports, as a page task adds to it in that file. Each request brings vars of its own, so the
    // Worker makes its shell from the lists as they are then.
    const list = authRoutes as ShellRoute[];

    expect(await sentOf(send("/test/example/added", { headers: READER }, varsWith({})))).toEqual(
      notFoundSent(TRACE_ID),
    );
    list.push(added);
    try {
      const response = await sendLater("/test/example/added", { headers: READER }, varsWith({}));

      expect(response.status).toBe(200);
      expect(headersOf(response)).toEqual(shellHeaders(TRACE_ID));
      expect(await response.text()).toContain('<main id="main" tabindex="-1">\n<h1>Added</h1>\n</main>');
    } finally {
      list.pop();
    }
    expect(authRoutes).not.toContain(added);
    expect(logLines()).toEqual([notFoundLine(TRACE_ID), pageLine(TRACE_ID, "example.added", 200)]);
  });

  it("serves a route of a folder web marks staging only (web/src/staging/test-phone/send/routes.ts) on staging, and answers its 404 where ENVIRONMENT is production, the handler never run", async () => {
    const logLines = captureLogLines();
    const runs = { count: 0 };
    const added: ShellRoute = {
      label: "example.tool",
      path: "/example/tool",
      methods: ["GET"],
      handle: (context) => {
        runs.count += 1;
        return context.page({ title: "Tool", main: "<h1>Tool</h1>" });
      },
    };
    const list = testPhoneSendRoutes as ShellRoute[];

    list.push(added);
    try {
      const onStaging = await sendLater("/test/example/tool", { headers: READER }, varsWith({}));

      expect(onStaging.status).toBe(200);
      expect(await onStaging.text()).toContain("<h1>Tool</h1>");
      expect(runs.count).toBe(1);

      // wrangler.jsonc's production vars: the route is like any address no route takes.
      const production = { ENVIRONMENT: "production", BASE_PATH: "" };
      for (const path of ["/example/tool", "/test/example/tool"]) {
        const response = await sendLater(path, { headers: READER }, varsWith(production));

        expect(await sentOf(response), path).toEqual(notFoundSent(TRACE_ID));
      }
      expect(runs.count).toBe(1);
    } finally {
      list.pop();
    }
    expect(testPhoneSendRoutes).not.toContain(added);
    expect(logLines()).toEqual([
      pageLine(TRACE_ID, "example.tool", 200),
      notFoundLine(TRACE_ID, "production"),
      notFoundLine(TRACE_ID, "production"),
    ]);
  });
});

/** The made-up session token of the page that signs out (rule 9). */
const SESSION_TOKEN = "dummy-session-token-0001";

/** The K-21 signOut request that page makes, under the page request's trace id `traceId`. */
function signOutRequest(traceId: string): Record<string, unknown> {
  return {
    page: { requestId: "req-example-0001", traceId, sessionToken: SESSION_TOKEN, linkCode: null },
  };
}

/** A made-up page that signs its reader out: one K-21 call through the route's client, its outcome kept in `outcomes`. */
function signOutProbe(outcomes: unknown[]): Probe {
  return async (context) => {
    outcomes.push(
      await context.client.call("signOut", {
        page: context.envelope({
          requestId: "req-example-0001",
          sessionToken: SESSION_TOKEN,
          linkCode: null,
        }),
      }),
    );
    return context.page({ title: "Signed out", main: "<h1>Signed out</h1>" });
  };
}

describe("a page's K-21 calls reach the page entry in process, never by a fetch (T-1234; T-511's security note a)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the call to the page entry's handler under the page request's trace id, and the page gets the handler's outcome; nothing is fetched", async () => {
    const logLines = captureLogLines();
    const fetched = vi.spyOn(globalThis, "fetch");
    const given: PageRequest[] = [];
    const outcomes: unknown[] = [];
    const made = workerOver(
      { shell: { modules: [exampleModule(signOutProbe(outcomes))] } },
      {
        signOut: (page) => {
          given.push(page);
          return Promise.resolve({ result: "signedOut", repeated: false });
        },
      },
    );

    const response = await ask(made, "/test/example/probe", { headers: READER });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Signed out</h1>");
    expect(outcomes).toEqual([{ result: "signedOut", repeated: false }]);
    expect(
      given.map((page) => ({
        call: page.call,
        request: page.request,
        traceId: page.trace.traceId,
        openedBy: page.trace.openedBy,
        environment: page.environment,
      })),
    ).toEqual([
      {
        call: "signOut",
        request: signOutRequest(TRACE_ID),
        traceId: TRACE_ID,
        openedBy: "pageRequest",
        environment: "staging",
      },
    ]);
    expect(fetched).not.toHaveBeenCalled();
    // One trace: the page entry's pageRequest span and the page's own line carry the page request's id.
    const lines = logLines();
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "span",
        trace_id: TRACE_ID,
        hop: "pageRequest",
        got: { pageCall: "signOut" },
        outcome: "ok",
      }),
    );
    expect(lines.filter((line) => (line as { msg?: unknown }).msg === "page")).toEqual([
      pageLine(TRACE_ID, "example.probe", 200),
    ]);
    // Nothing of the reader or of the call's request is logged on the way.
    const written = JSON.stringify(lines);
    for (const value of ["dummy-session-token", "req-example-0001", "Mozilla", "203.0.113.7", "rosie.test"])
      expect(written, value).not.toContain(value);
  });

  it("posts the call to an address built from the Worker's vars (LINK_HOST and BASE_PATH), never from the page request, with the trace id and nothing of the reader", async () => {
    captureLogLines();
    const fetched = vi.spyOn(globalThis, "fetch");
    const seen: unknown[] = [];
    const pageCall: PageCallRoute = async (request, call, vars) => {
      seen.push({
        call,
        method: request.method,
        url: request.url,
        headers: [...request.headers],
        body: await request.json(),
        environment: vars.ENVIRONMENT,
      });
      return new Response('{"result":"signedOut","repeated":false}', { status: 200 });
    };
    const outcomes: unknown[] = [];
    const made = workerOver({ shell: { modules: [exampleModule(signOutProbe(outcomes))] }, pageCall });
    const elsewhere = varsWith({ BASE_PATH: "/x-1", LINK_HOST: "links.example.test" });

    // The page requests come on rosie.test, a host no var names.
    expect(env.LINK_HOST).toBe("rosfield.com");
    expect((await ask(made, "/test/example/probe", { headers: READER })).status).toBe(200);
    expect((await ask(made, "/x-1/example/probe", { headers: READER }, elsewhere)).status).toBe(200);

    const posted = {
      call: "signOut",
      method: "POST",
      headers: [
        ["content-type", "application/json"],
        ["x-trace-id", TRACE_ID],
      ],
      body: signOutRequest(TRACE_ID),
      environment: "staging",
    };
    expect(seen).toEqual([
      { ...posted, url: "https://rosfield.com/test/page-api/signOut" },
      { ...posted, url: "https://links.example.test/x-1/page-api/signOut" },
    ]);
    expect(outcomes).toEqual([
      { result: "signedOut", repeated: false },
      { result: "signedOut", repeated: false },
    ]);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("is the one page entry the /page-api route answers with: a call's POST from outside reaches the same door", async () => {
    captureLogLines();
    const seen: unknown[] = [];
    const pageCall: PageCallRoute = (request, call) => {
      seen.push({ call, url: request.url });
      return Promise.resolve(new Response('{"result":"signedOut","repeated":false}', { status: 200 }));
    };
    const made = workerOver({ shell: { modules: [exampleModule(signOutProbe([]))] }, pageCall });

    const response = await ask(made, "/test/page-api/signOut", { method: "POST", body: "{}" });
    await ask(made, "/test/example/probe");

    expect(await response.text()).toBe('{"result":"signedOut","repeated":false}');
    expect(seen).toEqual([
      { call: "signOut", url: "https://rosie.test/test/page-api/signOut" },
      { call: "signOut", url: "https://rosfield.com/test/page-api/signOut" },
    ]);
  });

  it.each([301, 302, 303, 307, 308])(
    "a %i from the page entry is refused at the edge: the entry is asked once, nothing is fetched or followed, and the reader gets the shell's 500 page",
    async (status) => {
      const logLines = captureLogLines();
      const fetched = vi.spyOn(globalThis, "fetch");
      const thrown: unknown[] = [];
      const outcomes: unknown[] = [];
      let asked = 0;
      const pageCall: PageCallRoute = () => {
        asked += 1;
        return Promise.resolve(
          new Response(null, { status, headers: { location: "https://example.invalid/elsewhere" } }),
        );
      };
      const made = workerOver({
        shell: {
          modules: [exampleModule(signOutProbe(outcomes))],
          onRouteError: (error) => thrown.push(error),
        },
        pageCall,
      });

      const response = await ask(made, "/test/example/probe", { headers: READER });

      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        renderErrorPage({ status: 500, basePath: "/test", traceId: TRACE_ID }),
      );
      expect(asked).toBe(1);
      expect(fetched).not.toHaveBeenCalled();
      expect(outcomes).toEqual([]);
      expect(thrown).toHaveLength(1);
      expect(thrown[0]).toBeInstanceOf(PageApiError);
      expect(thrown[0]).toMatchObject({ code: "refusedAtEdge", call: "signOut", status });
      expect(logLines()).toEqual([pageLine(TRACE_ID, "example.probe", 500)]);
    },
  );

  it("a call whose handler is not joined gets the entry's own 503, which gives the page no outcome: the shell's 500 page, under one trace id", async () => {
    const logLines = captureLogLines();
    const thrown: unknown[] = [];
    const outcomes: unknown[] = [];
    const made = workerOver({
      shell: {
        modules: [exampleModule(signOutProbe(outcomes))],
        onRouteError: (error) => thrown.push(error),
      },
    });

    const response = await ask(made, "/test/example/probe", { headers: READER });

    expect(response.status).toBe(500);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(outcomes).toEqual([]);
    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toMatchObject({ code: "refusedAtEdge", call: "signOut", status: 503 });
    const lines = logLines();
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "span",
        trace_id: TRACE_ID,
        hop: "pageRequest",
        got: { pageCall: "signOut" },
        outcome: "failed",
        error_code: "notConnected",
      }),
    );
    expect(lines.filter((line) => (line as { msg?: unknown }).msg === "page")).toEqual([
      pageLine(TRACE_ID, "example.probe", 500),
    ]);
  });
});

describe("a page request the shell itself cannot answer gets a plain 500 with its trace id and one log line (T-1234; T-511's security note d)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A handler whose Response was already read: the shell cannot send it, and throws outside its own try. */
  const usedBody: Probe = async () => {
    const used = new Response("dummy-words the handler already read");
    await used.text();
    return used;
  };

  it("a handler's Response whose body was already read: a traced, logged 500 in place of the runtime's own error, with nothing of the handler or the reader in it", async () => {
    const logLines = captureLogLines();
    const made = workerOver({ shell: { modules: [exampleModule(usedBody)] } });

    const response = await ask(made, "/test/example/probe", { headers: READER });

    expect(await sentOf(response)).toEqual(pageFailedSent(TRACE_ID));
    expect(logLines()).toEqual([pageLine(TRACE_ID, "shellFailed", 500)]);
    const written = JSON.stringify(logLines());
    for (const value of ["dummy", "Mozilla", "203.0.113.7", "example.invalid", "rosie.test", "/example"])
      expect(written, value).not.toContain(value);
  });

  it("gives that 500 a new trace id when the request brings no valid one, the same in x-trace-id and in the line", async () => {
    const logLines = captureLogLines();
    const made = workerOver({ shell: { modules: [exampleModule(usedBody)] } });

    const response = await ask(made, "/test/example/probe", { headers: { "x-trace-id": "not-a-trace-id" } });
    const traceId = response.headers.get("x-trace-id") ?? "";

    expect(traceId).toMatch(UUID);
    expect(await sentOf(response)).toEqual(pageFailedSent(traceId));
    expect(logLines()).toEqual([pageLine(traceId, "shellFailed", 500)]);
  });

  it("a handler that throws is still the shell's own 500 page under the route's label, not this one", async () => {
    const logLines = captureLogLines();
    const made = workerOver({
      shell: {
        modules: [
          exampleModule(() => {
            throw new Error("dummy-secret-words from a handler");
          }),
        ],
      },
    });

    const response = await ask(made, "/test/example/probe", { headers: READER });

    expect(response.status).toBe(500);
    expect(headersOf(response)).toEqual(shellHeaders(TRACE_ID));
    expect(await response.text()).toBe(
      renderErrorPage({ status: 500, basePath: "/test", traceId: TRACE_ID }),
    );
    expect(logLines()).toEqual([pageLine(TRACE_ID, "example.probe", 500)]);
  });

  it("a route list the shell refuses (two routes under one label): every request that reaches web's pages gets the 500, and health answers as ever", async () => {
    const logLines = captureLogLines();
    const page: Probe = (context) => context.page({ title: "Same", main: "<h1>Same</h1>" });
    const made = workerOver({
      shell: {
        modules: [
          {
            folder: "example",
            stagingOnly: false,
            routes: [
              { label: "example.same", path: "/example/one", methods: ["GET"], handle: page },
              { label: "example.same", path: "/example/two", methods: ["GET"], handle: page },
            ],
          },
        ],
      },
    });

    for (const path of ["/test/example/one", "/test/privacy", "/test/unknown"]) {
      const response = await ask(made, path, { headers: READER });

      expect(await sentOf(response), path).toEqual(pageFailedSent(TRACE_ID));
    }
    const health = await ask(made, "/test/health", { headers: READER });
    expect(health.status).toBe(200);

    const failed = pageLine(TRACE_ID, "shellFailed", 500);
    expect(logLines()).toEqual([
      failed,
      failed,
      failed,
      { level: "info", msg: "health", trace_id: TRACE_ID, environment: "staging", version: "test-sha" },
    ]);
  });
});

describe("vars the shell cannot be made from fail closed for web's pages alone (T-1234; LINK_HOST is wrangler.jsonc's, T-1235)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: "no LINK_HOST", change: { LINK_HOST: undefined }, base: "/test" },
    { name: "a LINK_HOST that is no bare host", change: { LINK_HOST: "example.test/x" }, base: "/test" },
    { name: "a LINK_HOST that is not a string", change: { LINK_HOST: 7 }, base: "/test" },
    { name: "a BASE_PATH the frame refuses", change: { BASE_PATH: "/Test" }, base: "/Test" },
  ])(
    "$name: a page request gets web's own plain 500 with its trace id and one log line, and health, a webhook door and the page entry answer as ever",
    async ({ change, base }) => {
      const vars = varsWith(change);
      const webLines: string[] = [];
      const webEntry = createWebWorker({ transport: () => NO_CALLS, log: (line) => webLines.push(line) });
      const logLines = captureLogLines();

      // The privacy notice, and an address that would otherwise be the Worker's 404: no page is known without the
      // shell's vars, so every request that reaches web's pages is refused the same way.
      for (const path of [`${base}/privacy`, `${base}/unknown`]) {
        const init = { headers: READER };
        const fromWorker = await sentOf(await sendLater(path, init, vars));

        expect(fromWorker, path).toEqual(pageFailedSent(TRACE_ID));
        // Byte for byte the answer of web's own entry (web/src/shell/worker.ts) to the same request and vars.
        expect(fromWorker, path).toEqual(
          await sentOf(await webEntry.fetch(new Request(`https://rosie.test${path}`, init), vars)),
        );
      }
      const refused = pageLine(TRACE_ID, "config", 500);
      expect(logLines()).toEqual([refused, refused]);
      expect(webLines.map((line) => JSON.parse(line) as unknown)).toEqual([refused, refused]);
      vi.restoreAllMocks();

      // The routes before web's pages never read the shell's vars.
      captureLogLines();
      expect(await sentOf(await sendLater(`${base}/health`, { headers: READER }, vars))).toEqual({
        status: 200,
        headers: jsonHeaders(TRACE_ID),
        body: `{"ok":true,"service":"rosie","environment":"staging","version":"test-sha","trace_id":"${TRACE_ID}"}`,
      });
      expect(await sentOf(await sendLater(`${base}/webhooks/linq`, { headers: READER }, vars))).toEqual({
        status: 405,
        headers: jsonHeaders(TRACE_ID),
        body: `{"ok":false,"error":"method_not_allowed","trace_id":"${TRACE_ID}"}`,
      });
      const pageCall = await sendLater(
        `${base}/page-api/signOut`,
        { method: "POST", headers: { "x-trace-id": TRACE_ID }, body: "not json at all" },
        vars,
      );
      expect(await sentOf(pageCall)).toEqual({
        status: 400,
        headers: jsonHeaders(TRACE_ID),
        body: `{"ok":false,"error":"bad_request","trace_id":"${TRACE_ID}"}`,
      });
    },
  );
});

/** The HandleActor namespace env.staging binds (T-566), which the pool's env carries. */
function handleActorBinding(): DurableObjectNamespace {
  const namespace = env.HANDLE_ACTOR;
  if (namespace === undefined) throw new Error("env.staging binds no HANDLE_ACTOR");
  return namespace;
}

/**
 * The Worker's env for a retry batch: env.staging's vars and HandleActor binding under ENVIRONMENT `environment`, with the
 * retry queue's producer a double (../queues/test-support), so the next try a batch hands on is read here and never
 * reaches the pool's own queue.
 */
function retryEnv(environment: string, retryQueue: FakeQueue): Cloudflare.Env {
  return {
    ENVIRONMENT: environment,
    BASE_PATH: env.BASE_PATH,
    DB_SCHEMA: env.DB_SCHEMA,
    GIT_SHA: "test-sha",
    HANDLE_ACTOR: handleActorBinding(),
    RETRY_QUEUE: retryQueue as unknown as Queue,
  };
}

const RETRY_MESSAGE_ID = "0ft1223retry";

/**
 * A send job's second try as the dispatcher's run leaves it on the queue (runtime/src/dispatch/retry plan.ts: a row's
 * part that got no answer, run again under the same key), due now. Ids and labels only, made up (rule 9).
 */
function sendRetry(at: number): RetryMessage {
  return {
    v: 1,
    job: {
      key: "retry-out-t1223-row/1/1#1",
      kind: "send",
      businessId: "biz-t1223",
      traceId: TRACE_ID,
      body: {
        outboxRowId: "out-t1223-row",
        recipientHandleId: "handle-t1223",
        failedKey: "out-t1223-row/1/1",
        chain: "rerun",
        code: "noAnswer",
      },
    },
    try: 2,
    firstTriedAt: new Date(at - 10_000).toISOString(),
    notBefore: new Date(at).toISOString(),
    lastError: "SendFailed:noAnswer",
  };
}

/** The retry queue's log lines (runtime/src/queues consumer.ts): one per message handled. */
function retryLines(lines: unknown[]): unknown[] {
  return lines.filter(
    (line) => typeof line === "object" && line !== null && (line as { msg?: unknown }).msg === "retryQueue",
  );
}

describe("the retry queue's entry wires the isolate first, as the fetch entry does (T-1223)", () => {
  beforeEach(() => {
    // The earlier tests' requests wired this isolate: unwire it, so the batch meets it as a fresh isolate would.
    unwireWorker();
  });

  afterEach(() => {
    unwireWorker();
    vi.restoreAllMocks();
  });

  it("a retry batch that is the first event the isolate sees: the queue entry wires staging's root once, and the try runs at once through the dispatcher's door, never answered unwired", async () => {
    const logLines = captureLogLines();
    const retryQueue = fakeQueue(fakeClock("2026-11-11T12:00:00Z"));
    const vars = retryEnv("staging", retryQueue);
    const at = Date.now();
    const due = sendRetry(at);
    // Nothing is wired and the isolate has no retry queue ports: before T-1223 this batch was answered "unwired".
    expect(wiredRoot()).toBeNull();
    expect(queueDeps()).toBeNull();
    const root = workerRoot(vars);
    const install = vi.spyOn(root, "install");

    const { batch, result, retries } = batchOf([{ id: RETRY_MESSAGE_ID, body: due }], at);
    await worker.queue(batch, vars);

    expect(install).toHaveBeenCalledTimes(1);
    expect(wiredRoot()).toBe(root);
    expect(queueDeps()).toBe(root.queue);
    // The try ran: the door ran the recipient's rows again, whose claim staging's outbox refuses until T-567 binds its
    // database (NoDatabaseError), so the next try went on the queue at once and the message was acked, not held a minute.
    const handled = await result();
    expect(handled.explicitAcks).toEqual([RETRY_MESSAGE_ID]);
    expect(handled.retryMessages).toEqual([]);
    expect(retries).toEqual([]);
    expect(retryLines(logLines())).toEqual([
      {
        level: "info",
        msg: "retryQueue",
        trace_id: TRACE_ID,
        job_id: due.job.key,
        job_kind: "send",
        try: 2,
        message_id: RETRY_MESSAGE_ID,
        outcome: "queuedNext",
        error_code: "NoDatabaseError:threw",
        retry_in_s: null,
        environment: "staging",
        version: "test-sha",
      },
    ]);
    expect(retryQueue.sent.map((sent) => sent.options)).toEqual([
      { contentType: "json", delaySeconds: SEND_SPACING_S },
    ]);
    expect(retryQueue.sent[0]?.message).toEqual({
      ...due,
      try: 3,
      notBefore: expect.any(String) as unknown,
      lastError: "NoDatabaseError:threw",
    });

    // A request after it finds the isolate wired: the fetch entry does not wire it again.
    const health = await worker.fetch(
      new Request(`https://rosie.test${env.BASE_PATH}/health`),
      vars,
      createExecutionContext(),
    );
    expect(health.status).toBe(200);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("production: the queue entry wires production's root, every port closed as the fetch entry binds it, so the try claims and sends nothing", async () => {
    const logLines = captureLogLines();
    const retryQueue = fakeQueue(fakeClock("2026-11-11T12:00:00Z"));
    const vars = retryEnv("production", retryQueue);
    const at = Date.now();
    const due = sendRetry(at);
    expect(wiredRoot()).toBeNull();
    expect(queueDeps()).toBeNull();
    const root = workerRoot(vars);
    expect(root.environment).toBe("production");
    expect(root.bindings.filter((binding) => binding.implementation !== "closed")).toEqual([]);

    const { batch, result } = batchOf([{ id: RETRY_MESSAGE_ID, body: due }], at);
    await worker.queue(batch, vars);

    expect(wiredRoot()).toBe(root);
    expect(queueDeps()).toBe(root.queue);
    // The door's claim reaches production's closed outbox port (NotJoinedError): nothing is claimed or sent.
    expect((await result()).explicitAcks).toEqual([RETRY_MESSAGE_ID]);
    expect(retryLines(logLines())).toEqual([
      expect.objectContaining({
        outcome: "queuedNext",
        error_code: "NotJoinedError:threw",
        environment: "production",
      }),
    ]);
    expect(retryQueue.sent.map((sent) => sent.message.lastError)).toEqual(["NotJoinedError:threw"]);
  });
});
