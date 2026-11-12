// The shell's two POST guards (T-520; DL-487): a POST that is not from this site's own origin is refused before any
// handler runs, the origin being the config's and never the request's own host; and a POST body over the cap is refused
// before it is read in full. Run through the shell on a made-up form route; every value is made up (rule 9).
import { describe, expect, it } from "vitest";
import { readWebConfig } from "./config";
import { renderErrorPage } from "./error-pages";
import { POST_BODY_MAX_BYTES, fromThisSite, guardPost, siteOrigin } from "./post-guard";
import type { RouteModule } from "./route";
import { contentSecurityPolicy } from "./serve";
import { TEST_LINK_HOST, TRACE_ID, get, testShell, testVars } from "./test-support";

const ORIGIN = `https://${TEST_LINK_HOST}`;
const FORM_URL = `${ORIGIN}/test/example/form`;

/** A made-up folder with one form route, which keeps each body a POST handed it. */
function formModule(bodies: string[]): RouteModule {
  return {
    folder: "example",
    stagingOnly: false,
    routes: [
      {
        label: "example.form",
        path: "/example/form",
        methods: ["GET", "POST"],
        handle: async (context) => {
          if (context.request.method === "POST") bodies.push(await context.request.text());
          return context.page({ title: "Form", main: "<h1>Form</h1>", forms: true });
        },
      },
    ],
  };
}

/** A form's POST with the headers given and a small body. */
function post(headers: Record<string, string>, url = FORM_URL): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-trace-id": TRACE_ID, ...headers },
    body: "field=dummy-value",
  });
}

/** A POST whose body is a stream of `chunks` chunks of `size` bytes, with what was pulled from it and whether it was cancelled. */
function streamed(
  chunks: number,
  size: number,
  headers: Record<string, string> = {},
): { request: Request; state: { pulled: number; cancelled: boolean } } {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const init = { method: "POST", headers: { origin: ORIGIN, ...headers }, body, duplex: "half" };
  return { request: new Request(FORM_URL, init), state };
}

describe("a POST whose Origin is not this site's own origin is refused before any handler runs", () => {
  it.each([
    { name: "this site's own Origin", headers: { origin: ORIGIN } },
    {
      name: "its Origin beside the browser's same-origin word",
      headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    },
    {
      name: "Origin null, as a browser sends it from a no-referrer page, with Sec-Fetch-Site: same-origin",
      headers: { origin: "null", "sec-fetch-site": "same-origin" },
    },
    { name: "no Origin, with Sec-Fetch-Site: same-origin", headers: { "sec-fetch-site": "same-origin" } },
  ])("answers $name", async ({ headers }) => {
    const bodies: string[] = [];
    const { shell, lines } = testShell({ modules: [formModule(bodies)] });
    const response = await shell.fetch(post(headers));
    expect(response.status).toBe(200);
    expect(bodies).toEqual(["field=dummy-value"]);
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: TRACE_ID, route: "example.form", status: 200 },
    ]);
  });

  it.each([
    { name: "another site's Origin", headers: { origin: "https://example.invalid" } },
    { name: "this host over http", headers: { origin: `http://${TEST_LINK_HOST}` } },
    { name: "this host on another port", headers: { origin: `${ORIGIN}:8443` } },
    { name: "a host that only starts with this one", headers: { origin: `${ORIGIN}.example.invalid` } },
    { name: "a subdomain of this host", headers: { origin: `https://www.${TEST_LINK_HOST}` } },
    { name: "this origin with a path after it", headers: { origin: `${ORIGIN}/` } },
    { name: "no Origin and no Sec-Fetch-Site", headers: {} },
    { name: "Origin null alone", headers: { origin: "null" } },
    { name: "Origin null from another site", headers: { origin: "null", "sec-fetch-site": "cross-site" } },
    {
      name: "Origin null from the same site but another origin",
      headers: { origin: "null", "sec-fetch-site": "same-site" },
    },
    { name: "Origin null from no site at all", headers: { origin: "null", "sec-fetch-site": "none" } },
    {
      name: "another site's Origin, whatever Sec-Fetch-Site says",
      headers: { origin: "https://example.invalid", "sec-fetch-site": "same-origin" },
    },
    { name: "an empty Origin", headers: { origin: "", "sec-fetch-site": "same-origin" } },
  ])("refuses $name: the 403 page, one log line, and the handler never runs", async ({ headers }) => {
    const bodies: string[] = [];
    const { shell, lines, rawLines } = testShell({ modules: [formModule(bodies)] });
    const request = post({ ...headers, cookie: "session=dummy-session-token" });
    const response = await shell.fetch(request);
    expect(response.status).toBe(403);
    expect(bodies).toEqual([]);
    // Refused before any of the body is read.
    expect(request.bodyUsed).toBe(false);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toBe(
      renderErrorPage({ status: 403, basePath: "/test", traceId: TRACE_ID }),
    );
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: TRACE_ID, route: "example.form", status: 403 },
    ]);
    for (const value of ["example.invalid", "dummy", TEST_LINK_HOST])
      expect(rawLines().join("\n")).not.toContain(value);
  });

  it("takes this site's origin from the config (https:// + LINK_HOST), never from the request's own host or address", async () => {
    // A request that reached the Worker under another host, saying it comes from that same host, is still another site's.
    const bodies: string[] = [];
    const { shell, config } = testShell({ modules: [formModule(bodies)] });
    expect(siteOrigin(config)).toBe(ORIGIN);
    const elsewhere = post(
      { origin: "https://example.invalid", host: "example.invalid" },
      "https://example.invalid/test/example/form",
    );
    expect((await shell.fetch(elsewhere)).status).toBe(403);
    expect(bodies).toEqual([]);

    // With another LINK_HOST set, that host's origin is the one answered, and the tests' usual one is refused.
    const other = testShell({
      modules: [formModule(bodies)],
      vars: { ...testVars("staging"), LINK_HOST: "pages.example.test" },
    });
    expect(siteOrigin(other.config)).toBe("https://pages.example.test");
    expect((await other.shell.fetch(post({ origin: "https://pages.example.test" }))).status).toBe(200);
    expect((await other.shell.fetch(post({ origin: ORIGIN }))).status).toBe(403);
    expect(bodies).toEqual(["field=dummy-value"]);
  });

  it("reads the two headers as the config's origin alone decides", () => {
    const config = readWebConfig(testVars("production"));
    const ask = (headers: Record<string, string>): boolean =>
      fromThisSite(new Request(FORM_URL, { headers }), config);
    expect(ask({ origin: ORIGIN })).toBe(true);
    expect(ask({ "sec-fetch-site": "same-origin" })).toBe(true);
    expect(ask({ origin: "null", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(ask({ origin: ORIGIN.toUpperCase() })).toBe(false);
    expect(ask({ "sec-fetch-site": "Same-Origin" })).toBe(false);
    expect(ask({})).toBe(false);
  });

  it("asks no origin of a GET or a HEAD, and keeps the 405 and 404 pages for a POST no route takes", async () => {
    const bodies: string[] = [];
    const { shell } = testShell({ modules: [formModule(bodies)] });
    expect((await shell.fetch(get("/test/example/form"))).status).toBe(200);
    expect((await shell.fetch(new Request(FORM_URL, { method: "HEAD" }))).status).toBe(200);
    const other = { origin: "https://example.invalid" };
    expect((await shell.fetch(post(other, `${ORIGIN}/test/privacy`))).status).toBe(405);
    expect((await shell.fetch(post(other, `${ORIGIN}/test/unknown`))).status).toBe(404);
  });

  it("guards serve as it guards fetch", async () => {
    const bodies: string[] = [];
    const { shell } = testShell({ modules: [formModule(bodies)] });
    expect((await shell.serve(post({ origin: "https://example.invalid" })))?.status).toBe(403);
    expect((await shell.serve(post({ origin: ORIGIN })))?.status).toBe(200);
    expect(bodies).toEqual(["field=dummy-value"]);
  });
});

describe("a POST body over the cap is refused before it is read in full", () => {
  const sized = (bytes: number, headers: Record<string, string> = {}): Request =>
    new Request(FORM_URL, {
      method: "POST",
      headers: { origin: ORIGIN, "x-trace-id": TRACE_ID, ...headers },
      body: "a".repeat(bytes),
    });

  it("is a small fixed limit", () => {
    expect(POST_BODY_MAX_BYTES).toBe(16 * 1024);
  });

  it("hands the handler a body of exactly the cap, whole", async () => {
    const bodies: string[] = [];
    const { shell } = testShell({ modules: [formModule(bodies)] });
    expect((await shell.fetch(sized(POST_BODY_MAX_BYTES))).status).toBe(200);
    expect(bodies).toEqual(["a".repeat(POST_BODY_MAX_BYTES)]);
  });

  it("refuses a body one byte over: the 413 page, one log line, and the handler never runs", async () => {
    const bodies: string[] = [];
    const { shell, lines } = testShell({ modules: [formModule(bodies)] });
    const response = await shell.fetch(sized(POST_BODY_MAX_BYTES + 1));
    expect(response.status).toBe(413);
    expect(bodies).toEqual([]);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response.text()).toBe(
      renderErrorPage({ status: 413, basePath: "/test", traceId: TRACE_ID }),
    );
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: TRACE_ID, route: "example.form", status: 413 },
    ]);
  });

  it("refuses by the declared length without reading any of the body", async () => {
    const bodies: string[] = [];
    const { shell } = testShell({ modules: [formModule(bodies)] });
    for (const declared of [String(POST_BODY_MAX_BYTES + 1), "99999999999", "not-a-length", "-1", "1e3"]) {
      const { request } = streamed(4, 8, { "content-length": declared });
      expect(request.headers.get("content-length")).toBe(declared);
      expect((await shell.fetch(request)).status, declared).toBe(413);
      expect(request.bodyUsed, declared).toBe(false);
    }
    expect(bodies).toEqual([]);
  });

  it("stops reading a body with no declared length at the first byte past the cap, and cancels the rest", async () => {
    const bodies: string[] = [];
    const { shell } = testShell({ modules: [formModule(bodies)] });
    // 1,024 chunks of 1 KiB: 1 MiB in all, of which only a little over the cap may be pulled.
    const { request, state } = streamed(1024, 1024);
    expect(request.headers.has("content-length")).toBe(false);
    expect((await shell.fetch(request)).status).toBe(413);
    expect(bodies).toEqual([]);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeGreaterThan(POST_BODY_MAX_BYTES / 1024);
    expect(state.pulled).toBeLessThanOrEqual(POST_BODY_MAX_BYTES / 1024 + 4);
  });

  it("refuses a body longer than a small length it declared, by what is read", async () => {
    const { shell } = testShell({ modules: [formModule([])] });
    const { request, state } = streamed(1024, 1024, { "content-length": "8" });
    expect((await shell.fetch(request)).status).toBe(413);
    expect(state.cancelled).toBe(true);
  });

  it("hands the handler a streamed body under the cap, whole, with no declared length carried over", async () => {
    const { request } = streamed(3, 5, { "content-length": "15" });
    const guarded = await guardPost(request, readWebConfig(testVars("staging")));
    expect(guarded).toBeInstanceOf(Request);
    if (!(guarded instanceof Request)) return;
    expect(guarded.method).toBe("POST");
    expect(guarded.url).toBe(FORM_URL);
    expect(guarded.headers.get("origin")).toBe(ORIGIN);
    expect(guarded.headers.has("content-length")).toBe(false);
    expect(await guarded.text()).toBe("a".repeat(15));
  });

  it("checks the origin first: another site's oversized POST gets the 403 page, unread", async () => {
    const { shell } = testShell({ modules: [formModule([])] });
    const { request } = streamed(1024, 1024, { origin: "https://example.invalid" });
    expect((await shell.fetch(request)).status).toBe(403);
    expect(request.bodyUsed).toBe(false);
  });

  it("gives the 500 page, and the error to onRouteError alone, when the body cannot be read", async () => {
    const thrown: unknown[] = [];
    const bodies: string[] = [];
    const { shell, lines, rawLines } = testShell({
      modules: [formModule(bodies)],
      onRouteError: (error) => thrown.push(error),
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("dummy-secret-words from a broken body"));
      },
    });
    const init = {
      method: "POST",
      headers: { origin: ORIGIN, "x-trace-id": TRACE_ID },
      body,
      duplex: "half",
    };
    const response = await shell.fetch(new Request(FORM_URL, init));
    expect(response.status).toBe(500);
    expect(bodies).toEqual([]);
    expect(await response.text()).toBe(
      renderErrorPage({ status: 500, basePath: "/test", traceId: TRACE_ID }),
    );
    expect(thrown).toHaveLength(1);
    expect(lines()).toEqual([
      { level: "error", msg: "page", trace_id: TRACE_ID, route: "example.form", status: 500 },
    ]);
    expect(rawLines().join("\n")).not.toContain("dummy-secret-words");
  });
});
