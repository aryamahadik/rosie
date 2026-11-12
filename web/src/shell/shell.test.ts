// T-511's proofs for the web shell's pages: a known route renders a page with its language, a main landmark and a skip
// link; an unknown path gives a 404 page showing the trace id; every page response carries x-trace-id (a valid incoming
// one echoed) and logs one JSON line with it, holding the trace id, the route's label and the status only; and no page
// holds a CAPTCHA. Beside them: HEAD, the 405 and 500 pages, a page's form policy, and staging's test tools existing
// only on staging. The shell runs on the Tool API mock (test-support.ts); every request value is made up (rule 9).
import { describe, expect, it, vi } from "vitest";
import { mockTransport } from "../client/test-support";
import { renderPrivacyPage } from "../pages/privacy/page";
import { PAGE_ROUTES } from "../routes";
import { readWebConfig } from "./config";
import { ERROR_WORDS, REFERENCE_LABEL, renderErrorPage, type ErrorStatus } from "./error-pages";
import { PRIVACY_PATH } from "./frame";
import type { RouteModule, ShellRoute } from "./route";
import { contentSecurityPolicy, servePage } from "./serve";
import { createWebShell } from "./shell";
import {
  TEST_LINK_HOST,
  TRACE_ID,
  UUID,
  attributeValues,
  get,
  testShell,
  testVars,
  type TestEnvironment,
} from "./test-support";

/** A made-up feature folder's routes, as a page task would write them in its own routes.ts. */
const HELLO: ShellRoute = {
  label: "example.hello",
  path: "/example/hello",
  methods: ["GET"],
  handle: (context) => context.page({ title: "Hello <there>", main: "<h1>Hello</h1>" }),
};
const FORM: ShellRoute = {
  label: "example.form",
  path: "/example/form",
  methods: ["GET", "POST"],
  handle: (context) =>
    context.page({
      title: "Form",
      main: `<h1>Form</h1>\n<form method="post" action="${context.config.basePath}/example/form"><button>Send</button></form>`,
      forms: true,
    }),
};
const BROKEN: ShellRoute = {
  label: "example.broken",
  path: "/example/broken",
  methods: ["GET"],
  handle: () => {
    throw new Error("dummy-secret-words from a handler");
  },
};
const NO_ANSWER: ShellRoute = {
  label: "example.noAnswer",
  path: "/example/no-answer",
  methods: ["GET"],
  handle: () => "not a response" as unknown as Response,
};
const ITEM: ShellRoute = {
  label: "example.item",
  path: "/example/items/:item",
  methods: ["GET"],
  handle: (context) =>
    context.params.item === "known-item"
      ? context.page({ title: "Item", main: "<h1>Item</h1>" })
      : context.notFound(),
};
const EXAMPLE: RouteModule = {
  folder: "example",
  stagingOnly: false,
  routes: [HELLO, FORM, BROKEN, NO_ANSWER, ITEM],
};

/** A made-up staging test tool's folder. */
const TOOL: RouteModule = {
  folder: "example/tool",
  stagingOnly: true,
  routes: [
    {
      label: "example.tool",
      path: "/example/tool",
      methods: ["GET"],
      handle: (context) => context.page({ title: "Tool", main: "<h1>Tool</h1>" }),
    },
  ],
};

/** A reader's request headers as a browser could send them, made up (rule 9). */
const READER = {
  cookie: "session=dummy-session-token",
  "user-agent": "Mozilla/5.0 (made-up reader)",
  "x-forwarded-for": "203.0.113.7",
  referer: "https://example.invalid/from",
};

/** Does nothing with what a handler threw, as the Worker does: the shell then sends its 500 page. */
const quiet = (): void => undefined;

/** What WCAG 2.1 AA asks of every page's frame (RULES 4.11): the language, one main landmark, a skip link to it. */
function expectFrame(html: string): void {
  expect(html.startsWith('<!doctype html>\n<html lang="en">\n')).toBe(true);
  expect(html.match(/<main[\s>]/g)).toHaveLength(1);
  expect(html).toContain('<main id="main" tabindex="-1">');
  expect(html).toContain('<a class="skip" href="#main">Skip to main content</a>');
  expect(html.indexOf('<a class="skip"')).toBeLessThan(html.indexOf("<main"));
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html).toMatch(/<h1>[^<]+<\/h1>/);
}

/** The reference line every error page shows. */
const referenceLine = (traceId: string): string => `<p>${REFERENCE_LABEL}: <code>${traceId}</code></p>`;

describe("a known route renders a page with lang, a main landmark and a skip link", () => {
  it.each<TestEnvironment>(["staging", "production"])(
    "the privacy notice at BASE_PATH + /privacy on %s, the page servePage gives, byte for byte",
    async (environment) => {
      const { shell, config } = testShell({ environment });
      const response = await shell.fetch(get(`${config.basePath}${PRIVACY_PATH}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toBe(renderPrivacyPage(config.basePath));
      expectFrame(html);
    },
  );

  it("serves every static page with the headers servePage gives it, and x-trace-id beside them", async () => {
    const { shell, config } = testShell();
    expect(PAGE_ROUTES.length).toBeGreaterThan(0);
    for (const page of PAGE_ROUTES) {
      const request = get(`${config.basePath}${page.path}`);
      const served = servePage(request, config.basePath);
      const response = await shell.fetch(request);
      expect(served).not.toBeNull();
      expect(response.status).toBe(200);
      expect([...response.headers].filter(([name]) => name !== "x-trace-id")).toEqual([
        ...(served?.headers ?? []),
      ]);
      expect(response.headers.get("x-trace-id")).toMatch(UUID);
      expect(await response.text()).toBe(await served?.text());
    }
  });

  it("a feature folder's page, through the frame: the language, the escaped title, main, the skip link and the footer's privacy link", async () => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    const response = await shell.fetch(get("/test/example/hello"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    const html = await response.text();
    expectFrame(html);
    expect(html).toContain("<title>Hello &lt;there&gt;</title>");
    expect(html).toContain('<main id="main" tabindex="-1">\n<h1>Hello</h1>\n</main>');
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/privacy"]);
    // A feature page is not for search engines unless it says so.
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("hands a route the values its path's :name took, as the address gave them", async () => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    expect((await shell.fetch(get("/test/example/items/known-item"))).status).toBe(200);
    expect((await shell.fetch(get("/test/example/items/known-item?from=text"))).status).toBe(200);
  });
});

describe("an unknown path gives a 404 page showing the trace id", () => {
  it.each([
    "/test/unknown",
    "/test",
    "/test/",
    "/test/privacy/",
    "/test/Privacy",
    "/test/privacy/more",
    "/testprivacy",
    "/privacy",
    "/",
    "/test/example/items",
    "/test/example/items/known-item/more",
  ])("%s: the 404 page, inside the frame, with the given trace id as its reference", async (path) => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    const response = await shell.fetch(get(path, { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    const html = await response.text();
    expect(html).toBe(renderErrorPage({ status: 404, basePath: "/test", traceId: TRACE_ID }));
    expectFrame(html);
    expect(html).toContain(`<h1>${ERROR_WORDS[404].title}</h1>`);
    expect(html).toContain(referenceLine(TRACE_ID));
    expect(attributeValues(html, "href")).toEqual(["#main", "/test/privacy"]);
  });

  it("shows a new trace id, the one in x-trace-id, when the request brings none", async () => {
    const { shell } = testShell();
    const response = await shell.fetch(get("/test/unknown"));
    const traceId = response.headers.get("x-trace-id") ?? "";
    expect(traceId).toMatch(UUID);
    expect(await response.text()).toContain(referenceLine(traceId));
  });

  it("never shows an incoming x-trace-id that is not a valid id, nor the address asked for", async () => {
    const { shell } = testShell();
    for (const given of ["<b>dummy-id</b>", "not-a-trace-id", `${TRACE_ID}0`, ""]) {
      const response = await shell.fetch(
        get("/test/dummy-unknown-address?q=dummy-query", { "x-trace-id": given }),
      );
      const traceId = response.headers.get("x-trace-id") ?? "";
      expect(traceId, given).toMatch(UUID);
      expect(traceId).not.toBe(TRACE_ID);
      const html = await response.text();
      expect(html).toBe(renderErrorPage({ status: 404, basePath: "/test", traceId }));
      for (const value of ["dummy-id", "not-a-trace-id", "dummy-unknown-address", "dummy-query"])
        expect(html).not.toContain(value);
    }
  });

  it("is the page a route gives for an address whose :name names nothing", async () => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    const response = await shell.fetch(get("/test/example/items/dummy-item", { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      renderErrorPage({ status: 404, basePath: "/test", traceId: TRACE_ID }),
    );
  });

  it("is in production's base path too", async () => {
    const { shell } = testShell({ environment: "production" });
    const response = await shell.fetch(get("/test/privacy", { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain(referenceLine(TRACE_ID));
    expect(attributeValues(html, "href")).toEqual(["#main", "/privacy"]);
  });
});

describe("every page response carries x-trace-id (a valid incoming one echoed) and logs one JSON line with it", () => {
  const CASES: { name: string; path: string; method: string; status: number; route: string }[] = [
    { name: "a static page", path: "/test/privacy", method: "GET", status: 200, route: "privacy" },
    { name: "a static page's HEAD", path: "/test/privacy", method: "HEAD", status: 200, route: "privacy" },
    {
      name: "a feature page",
      path: "/test/example/hello",
      method: "GET",
      status: 200,
      route: "example.hello",
    },
    { name: "a form's POST", path: "/test/example/form", method: "POST", status: 200, route: "example.form" },
    { name: "an unknown path", path: "/test/unknown", method: "GET", status: 404, route: "notFound" },
    {
      name: "a POST to an unknown path",
      path: "/test/unknown",
      method: "POST",
      status: 404,
      route: "notFound",
    },
    {
      name: "a route's own 404",
      path: "/test/example/items/x",
      method: "GET",
      status: 404,
      route: "example.item",
    },
    {
      name: "a method the route does not take",
      path: "/test/privacy",
      method: "POST",
      status: 405,
      route: "privacy",
    },
    {
      name: "a handler that throws",
      path: "/test/example/broken",
      method: "GET",
      status: 500,
      route: "example.broken",
    },
    {
      name: "a handler with no Response",
      path: "/test/example/no-answer",
      method: "GET",
      status: 500,
      route: "example.noAnswer",
    },
  ];

  it.each(CASES)("$name ($method $path): $status, the given id echoed in lower case, one line", async (c) => {
    const { shell, lines, rawLines } = testShell({ modules: [EXAMPLE], onRouteError: quiet });
    const response = await shell.fetch(
      new Request(`https://${TEST_LINK_HOST}${c.path}`, {
        method: c.method,
        // A POST is answered only from this site's own origin (post-guard.ts; T-520).
        headers: { ...READER, origin: `https://${TEST_LINK_HOST}`, "x-trace-id": TRACE_ID.toUpperCase() },
      }),
    );
    expect(response.status).toBe(c.status);
    expect(response.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(lines()).toEqual([
      {
        level: c.status >= 500 ? "error" : "info",
        msg: "page",
        trace_id: TRACE_ID,
        route: c.route,
        status: c.status,
      },
    ]);
    // The line holds the trace id, the route's label and the status only: nothing of the reader or the request.
    expect(Object.keys(lines()[0] ?? {})).toEqual(["level", "msg", "trace_id", "route", "status"]);
    for (const value of [...Object.values(READER), "dummy", "203.0.113.7", TEST_LINK_HOST, c.path])
      expect(rawLines().join("\n")).not.toContain(value);
  });

  it.each(CASES)(
    "$name ($method $path): a new id when none comes in, the same in the header and the line",
    async (c) => {
      const { shell, lines } = testShell({ modules: [EXAMPLE], onRouteError: quiet });
      const response = await shell.fetch(
        new Request(`https://${TEST_LINK_HOST}${c.path}`, { method: c.method }),
      );
      const traceId = response.headers.get("x-trace-id") ?? "";
      expect(traceId).toMatch(UUID);
      expect(lines().map((line) => line.trace_id)).toEqual([traceId]);
    },
  );

  it("makes a new id when the incoming one is not a valid id, and never echoes or logs what came", async () => {
    for (const given of ["not-a-trace-id", `${TRACE_ID}0`, "<script>", " "]) {
      const { shell, lines, rawLines } = testShell();
      const response = await shell.fetch(get("/test/privacy", { "x-trace-id": given }));
      const traceId = response.headers.get("x-trace-id") ?? "";
      expect(traceId, given).toMatch(UUID);
      expect(traceId).not.toBe(TRACE_ID);
      expect(lines()).toEqual([
        { level: "info", msg: "page", trace_id: traceId, route: "privacy", status: 200 },
      ]);
      expect(rawLines().join("\n")).not.toContain("not-a-trace-id");
    }
  });

  it("gives each request its own id and its own line", async () => {
    const { shell, lines } = testShell();
    const first = await shell.fetch(get("/test/privacy"));
    const second = await shell.fetch(get("/test/unknown"));
    const ids = [first.headers.get("x-trace-id"), second.headers.get("x-trace-id")];
    expect(ids[0]).not.toBe(ids[1]);
    expect(lines().map((line) => [line.trace_id, line.route, line.status])).toEqual([
      [ids[0], "privacy", 200],
      [ids[1], "notFound", 404],
    ]);
  });

  it("uses the id maker it is handed", async () => {
    const { shell, lines } = testShell({ newTraceId: () => TRACE_ID });
    expect((await shell.fetch(get("/test/privacy"))).headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(lines().map((line) => line.trace_id)).toEqual([TRACE_ID]);
  });

  it("writes its one line to console.log when no log is handed in (Workers Logs), with the lists web/src/routes.ts holds", async () => {
    const written = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const shell = createWebShell({
        config: readWebConfig(testVars("staging")),
        transport: mockTransport("staging"),
      });
      const response = await shell.fetch(get("/test/privacy", { "x-trace-id": TRACE_ID }));
      expect(response.status).toBe(200);
      expect(written.mock.calls).toEqual([
        [JSON.stringify({ level: "info", msg: "page", trace_id: TRACE_ID, route: "privacy", status: 200 })],
      ]);
    } finally {
      written.mockRestore();
    }
  });

  it("shows and logs nothing a handler threw: the 500 page holds the trace id alone, and the error goes only to onRouteError", async () => {
    const thrown: unknown[] = [];
    const { shell, rawLines } = testShell({
      modules: [EXAMPLE],
      onRouteError: (error) => thrown.push(error),
    });
    const response = await shell.fetch(get("/test/example/broken", { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toBe(renderErrorPage({ status: 500, basePath: "/test", traceId: TRACE_ID }));
    expectFrame(html);
    expect(html).toContain(referenceLine(TRACE_ID));
    expect(html).not.toContain("dummy-secret-words");
    expect(rawLines().join("\n")).not.toContain("dummy-secret-words");
    expect(thrown).toHaveLength(1);
    expect((thrown[0] as Error).message).toBe("dummy-secret-words from a handler");
  });

  it("a test shell throws a handler's error again, so a page test fails on it instead of reading a 500 page", async () => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    await expect(shell.fetch(get("/test/example/broken"))).rejects.toThrow(
      "dummy-secret-words from a handler",
    );
  });
});

describe("serve: null for an address no route takes, so a Worker with routes of its own keeps its 404", () => {
  it("gives null and logs nothing for an unknown path, a path outside BASE_PATH and a :name path's near misses", () => {
    const { shell, rawLines } = testShell({ modules: [EXAMPLE] });
    for (const path of [
      "/test/unknown",
      "/privacy",
      "/test",
      "/test/",
      "/test/health",
      "/test/example/items",
    ])
      expect(shell.serve(get(path)), path).toBeNull();
    expect(rawLines()).toEqual([]);
  });

  it("gives a route's answer as fetch does: the page, x-trace-id and one line", async () => {
    const { shell, lines } = testShell({ modules: [EXAMPLE] });
    const served = shell.serve(get("/test/privacy", { "x-trace-id": TRACE_ID }));
    expect(served).not.toBeNull();
    const response = await served;
    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-trace-id")).toBe(TRACE_ID);
    expect(await response?.text()).toBe(renderPrivacyPage("/test"));
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: TRACE_ID, route: "privacy", status: 200 },
    ]);
  });
});

describe("methods: HEAD rides with GET, and any method a route does not take gets the 405 page", () => {
  it("gives HEAD the GET answer's status and headers with no body", async () => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    for (const path of ["/test/privacy", "/test/example/hello", "/test/unknown"]) {
      const got = await shell.fetch(get(path, { "x-trace-id": TRACE_ID }));
      const head = await shell.fetch(
        new Request(`https://${TEST_LINK_HOST}${path}`, {
          method: "HEAD",
          headers: { "x-trace-id": TRACE_ID },
        }),
      );
      expect(head.status, path).toBe(got.status);
      expect([...head.headers]).toEqual([...got.headers]);
      expect(await head.text()).toBe("");
      expect((await got.text()).length).toBeGreaterThan(0);
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "%s on a page that takes GET alone: the 405 page with Allow: GET, HEAD and the trace id",
    async (method) => {
      const { shell } = testShell();
      const response = await shell.fetch(
        new Request(`https://${TEST_LINK_HOST}/test/privacy`, {
          method,
          headers: { "x-trace-id": TRACE_ID },
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.has("set-cookie")).toBe(false);
      const html = await response.text();
      expect(html).toBe(renderErrorPage({ status: 405, basePath: "/test", traceId: TRACE_ID }));
      expectFrame(html);
    },
  );

  it("names POST in Allow for a route that takes it, and still refuses the rest", async () => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    const send = (method: string): Promise<Response> =>
      shell.fetch(
        new Request(`https://${TEST_LINK_HOST}/test/example/form`, {
          method,
          // A POST is answered only from this site's own origin (post-guard.ts; T-520).
          headers: { origin: `https://${TEST_LINK_HOST}` },
        }),
      );
    expect((await send("POST")).status).toBe(200);
    const refused = await send("PUT");
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET, HEAD, POST");
  });
});

describe("a page's content security policy loads nothing; a page that holds a form may post to this site only", () => {
  it("allows no form on a page that names none, and form-action 'self' alone on one that does", async () => {
    const { shell } = testShell({ modules: [EXAMPLE] });
    const plain = await shell.fetch(get("/test/example/hello"));
    const form = await shell.fetch(get("/test/example/form"));
    expect(plain.headers.get("content-security-policy")?.split("; ")).toContain("form-action 'none'");
    const policy = form.headers.get("content-security-policy")?.split("; ") ?? [];
    expect(policy).toEqual(contentSecurityPolicy({ forms: true }).split("; "));
    expect(policy).toContain("form-action 'self'");
    expect(policy.filter((part) => !part.startsWith("form-action"))).toEqual(
      contentSecurityPolicy()
        .split("; ")
        .filter((part) => !part.startsWith("form-action")),
    );
  });
});

describe("no page contains a CAPTCHA (C-185)", () => {
  /** What a CAPTCHA would put in a page: its name, or the script or frame it loads. */
  const CAPTCHA = /captcha|turnstile|challenge-platform|arkose|<script|<iframe|<frame|<object|<embed/i;

  it("none of the pages the shell serves holds one, and no page's policy lets one load", async () => {
    const pages: { what: string; response: Response }[] = [];
    for (const environment of ["staging", "production"] as const) {
      const { shell, config } = testShell({ environment, modules: [EXAMPLE, TOOL], onRouteError: quiet });
      for (const page of PAGE_ROUTES)
        pages.push({ what: page.label, response: await shell.fetch(get(`${config.basePath}${page.path}`)) });
      for (const route of [...EXAMPLE.routes, ...TOOL.routes]) {
        const path = route.path.replace(":item", "known-item");
        pages.push({ what: route.label, response: await shell.fetch(get(`${config.basePath}${path}`)) });
      }
      pages.push({ what: "404", response: await shell.fetch(get(`${config.basePath}/unknown`)) });
      pages.push({
        what: "405",
        response: await shell.fetch(
          new Request(`https://${TEST_LINK_HOST}${config.basePath}${PRIVACY_PATH}`, { method: "DELETE" }),
        ),
      });
    }
    // Every status the shell answers with is among them.
    expect([...new Set(pages.map((page) => page.response.status))].sort((a, b) => a - b)).toEqual([
      200, 404, 405, 500,
    ]);
    for (const { what, response } of pages) {
      const html = await response.text();
      expect(html, what).not.toMatch(CAPTCHA);
      expect(attributeValues(html, "src"), what).toEqual([]);
      const policy = response.headers.get("content-security-policy")?.split("; ") ?? [];
      expect(policy[0], what).toBe("default-src 'none'");
      expect(policy.filter((part) => /^(?:script|frame|child|connect|worker)-src/.test(part))).toEqual([]);
    }
  });

  it("no error page's words name one", () => {
    for (const status of [404, 405, 500] satisfies ErrorStatus[])
      expect(renderErrorPage({ status, basePath: "", traceId: TRACE_ID })).not.toMatch(CAPTCHA);
  });
});

describe("staging's test tools exist only on staging (build prompt 9.4)", () => {
  it("serves a staging-only folder's route when ENVIRONMENT is staging", async () => {
    const { shell } = testShell({ modules: [TOOL] });
    expect((await shell.fetch(get("/test/example/tool"))).status).toBe(200);
  });

  it.each(["production", "Staging", "staging ", "preview", "stage"])(
    'gives the 404 page for it when ENVIRONMENT is "%s", as for any unknown address, and serve gives null',
    async (environment) => {
      for (const basePath of ["", "/test"]) {
        const { shell, lines } = testShell({
          modules: [TOOL, EXAMPLE],
          vars: { ...testVars("staging"), ENVIRONMENT: environment, BASE_PATH: basePath },
        });
        const request = get(`${basePath}/example/tool`, { "x-trace-id": TRACE_ID });
        expect(shell.serve(request)).toBeNull();
        const response = await shell.fetch(request);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe(renderErrorPage({ status: 404, basePath, traceId: TRACE_ID }));
        expect(lines().map((line) => line.route)).toEqual(["notFound"]);
        // The folders that are not staging only are served as everywhere.
        expect((await shell.fetch(get(`${basePath}/example/hello`))).status).toBe(200);
      }
    },
  );
});
