// The Worker's own routes, run inside the Workers runtime (Vitest project "workers"): the health endpoint and the 404,
// and web's pages, which the Worker serves last before its 404 (T-1192): the privacy notice T-1171 built, at
// {BASE_PATH}/privacy, with its headers as web sets them, while the Linq webhook, the page entry and the other routes
// before it answer as they did. The Worker gets wrangler.jsonc's staging vars (ENVIRONMENT "staging", BASE_PATH "/test")
// and GIT_SHA "test-sha" from vitest.config.ts. A reader's values are made up (rule 9): a documentation IP address and
// dummy tokens. And the retry queue's entry (T-1223): a retry batch that is the first event an isolate sees wires the
// isolate first, as a request does, so its try runs at once and is never answered "unwired"; its ids are made up too.
import { renderPrivacyPage } from "@rosie/web/src/pages/privacy/page";
import { contentSecurityPolicy, pageHeaders } from "@rosie/web/src/shell/serve";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./index";
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

/** One answer as it was sent: its status, every header and its body's text. */
async function sentOf(
  response: Response,
): Promise<{ status: number; headers: [string, string][]; body: string }> {
  return { status: response.status, headers: headersOf(response), body: await response.text() };
}

/** The headers of every JSON answer the Worker and its gateway give, in the order Headers gives them. */
function jsonHeaders(traceId: string): [string, string][] {
  return [
    ["cache-control", "no-store"],
    ["content-type", "application/json; charset=utf-8"],
    ["x-trace-id", traceId],
  ];
}

// T-1234: these answers were written down from the Worker as it was before it served the shell (main at 16af5be, where
// this block passed against the servePage Worker), and the shell Worker must give the same bytes.
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
