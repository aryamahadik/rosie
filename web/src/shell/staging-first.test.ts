// T-520 round 2's proofs for the order of the shell's checks (DL-491; build prompt 9.4): outside staging a staging
// tool's route is not there, and the shell says so before its POST guards (post-guard.ts) look at the request. So the
// answer is an unknown address's whatever the request carries (no Origin, another site's, this site's own, a body over
// the cap): the 404 page from fetch and null from serve, never the guards' 403 or 413, with no handler called and none
// of the body read. On staging, and for every route that is not guarded, the guards answer as they did. Beside them:
// an unknown address still answers 404 to any POST. The tool is made up, written as a test tool's routes.ts would
// write it, each handler a spy; every request value is made up (rule 9).
import { describe, expect, it, vi, type Mock } from "vitest";
import { mockTransport } from "../client/test-support";
import { stagingOnlyRoutes, type RouteHandler } from "../staging/guard";
import { readWebConfig } from "./config";
import { renderErrorPage } from "./error-pages";
import { POST_BODY_MAX_BYTES } from "./post-guard";
import type { RouteMethod, RouteModule, ShellRoute } from "./route";
import { createWebShell, type PageLogLine } from "./shell";
import { TEST_LINK_HOST, TRACE_ID, rethrow, testShell, testVars } from "./test-support";

const ORIGIN = `https://${TEST_LINK_HOST}`;

/** A made-up test tool: its routes behind the staging-only guard, each handler a spy that reads what was posted. */
interface Tool {
  readonly routes: readonly ShellRoute[];
  /** How many times any handler of the tool was called. */
  readonly calls: () => number;
}

function makeTool(): Tool {
  const spies: Mock<RouteHandler>[] = [];
  const route = (label: string, path: string, methods: readonly RouteMethod[]): ShellRoute => {
    const spy = vi.fn<RouteHandler>(async (context) => {
      if (context.request.method === "POST") await context.request.text();
      return context.page({ title: "Tool", main: `<h1>Tool ${label}</h1>`, forms: true });
    });
    spies.push(spy);
    return { label, path, methods, handle: spy };
  };
  const routes = stagingOnlyRoutes([
    route("example.tool.page", "/staging/example-tool", ["GET"]),
    route("example.tool.send", "/staging/example-tool/send", ["POST"]),
    route("example.tool.both", "/staging/example-tool/both", ["GET", "POST"]),
    route("example.tool.item", "/staging/example-tool/items/:item", ["GET", "POST"]),
  ]);
  return { routes, calls: () => spies.reduce((count, spy) => count + spy.mock.calls.length, 0) };
}

/** The tool's folder as the shell is handed it, with the folder's staging-only mark or without it. */
const folderOf = (tool: Tool, marked: boolean): RouteModule => ({
  folder: "staging/example-tool",
  stagingOnly: marked,
  routes: tool.routes,
});

const LAYERS = [
  { layers: "the folder's staging-only mark and the guard's mark, as web/src/routes.ts lists a tool", marked: true },
  { layers: "the guard's mark alone, the folder's staging-only mark lost", marked: false },
];

/** Vars of a web app that is not on staging: production, and values that are not exactly "staging". */
const OUTSIDE_STAGING = [
  { where: "ENVIRONMENT production", vars: testVars("production") },
  { where: 'ENVIRONMENT "Staging" under /test', vars: { ...testVars("staging"), ENVIRONMENT: "Staging" } },
  { where: 'ENVIRONMENT "staging " under /test', vars: { ...testVars("staging"), ENVIRONMENT: "staging " } },
];

const METHODS = ["GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS"] as const;
type Method = (typeof METHODS)[number];

/** Who the request says it comes from. */
const SENDERS: { from: string; headers: Record<string, string> }[] = [
  { from: "no Origin", headers: {} },
  { from: "another site's Origin", headers: { origin: "https://example.invalid" } },
  { from: "this site's own Origin", headers: { origin: ORIGIN } },
  {
    from: "Origin null with the browser's same-origin word",
    headers: { origin: "null", "sec-fetch-site": "same-origin" },
  },
];

/** What the request carries: nothing, a small form, or 1 MiB (64 times the cap), with or without its length declared. */
const BODIES = ["no body", "a small body", "a body over the cap", "a body declared over the cap"] as const;
type Body = (typeof BODIES)[number];

/** GET and HEAD carry no body; every other method is asked with each. */
const bodiesOf = (method: Method): readonly Body[] =>
  method === "GET" || method === "HEAD" ? ["no body"] : BODIES;

/** True when the route takes the method: HEAD rides with GET (shell.ts). */
const takes = (route: ShellRoute, method: Method): boolean =>
  route.methods.some((taken) => taken === method || (taken === "GET" && method === "HEAD"));

/** The route's address under the base path, its :item named. */
const addressOf = (basePath: string, route: ShellRoute): string =>
  `${basePath}${route.path.replace(":item", "dummy-item")}`;

/** One request, with how many chunks of its body have been read. */
interface Asked {
  readonly request: Request;
  readonly pulled: () => number;
}

/**
 * One request at `address`, under the tests' trace id. Its body is a stream that hands out nothing until it is read
 * (highWaterMark 0), so every chunk pulled is a chunk someone read.
 */
function ask(address: string, method: Method, headers: Record<string, string>, body: Body): Asked {
  const url = `https://${TEST_LINK_HOST}${address}`;
  const sent = { "x-trace-id": TRACE_ID, ...headers };
  if (body === "no body") return { request: new Request(url, { method, headers: sent }), pulled: () => 0 };
  const chunks = body === "a small body" ? 1 : 1024;
  const size = body === "a small body" ? 16 : 1024;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled === chunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(size).fill(97));
      },
    },
    { highWaterMark: 0 },
  );
  const declared =
    body === "a body declared over the cap" ? { "content-length": String(POST_BODY_MAX_BYTES + 1) } : {};
  const init = { method, headers: { ...sent, ...declared }, body: stream, duplex: "half" };
  return { request: new Request(url, init), pulled: () => pulled };
}

/** The one log line of a request no route answers. */
const NOT_FOUND_LINE = JSON.stringify({
  level: "info",
  msg: "page",
  trace_id: TRACE_ID,
  route: "notFound",
  status: 404,
} satisfies PageLogLine);

describe("outside staging a guarded route answers as an unknown address does, before the POST guards see the request", () => {
  describe.each(OUTSIDE_STAGING)("$where", ({ vars }) => {
    it.each(LAYERS)(
      "$layers: GET, POST, HEAD, PUT, DELETE and OPTIONS, from anyone and with any body, get an unknown address's answer; no handler is called and no body is read",
      async ({ marked }) => {
        const tool = makeTool();
        const { shell, config, rawLines, transport } = testShell({ modules: [folderOf(tool, marked)], vars });
        expect(config.staging).toBe(false);
        const { basePath } = config;
        let same = 0;
        let limit = 0;
        for (const route of tool.routes) {
          for (const method of METHODS) {
            for (const { from, headers } of SENDERS) {
              for (const body of bodiesOf(method)) {
                const what = `${method} ${addressOf(basePath, route)}, ${from}, ${body}`;
                const asked = ask(addressOf(basePath, route), method, headers, body);
                if (!marked && !takes(route, method)) {
                  // The limit of the guard alone, which T-522's tests hold (staging/guard/guard.test.ts expectNoTool;
                  // guard.ts, "One limit"): a method the route does not take gets the shell's method answer before
                  // any other check. It is not this card's to change. Here: still no answer of the POST guards, and
                  // nothing read.
                  const response = await shell.fetch(asked.request);
                  expect([403, 413], what).not.toContain(response.status);
                  expect(response.status, what).toBeGreaterThanOrEqual(400);
                  expect(asked.pulled(), what).toBe(0);
                  expect(asked.request.bodyUsed, what).toBe(false);
                  limit += 1;
                  continue;
                }
                const unknown = ask(`${basePath}/dummy-unknown-address`, method, headers, body);
                const before = rawLines().length;
                // serve: null, as for an unknown address, and nothing logged.
                expect(shell.serve(unknown.request), what).toBeNull();
                expect(shell.serve(asked.request), what).toBeNull();
                expect(rawLines().length, what).toBe(before);
                // fetch: the 404 page, with the header list, the body and the log line of an unknown address.
                const expected = await shell.fetch(unknown.request);
                const response = await shell.fetch(asked.request);
                expect(expected.status, what).toBe(404);
                expect(response.status, what).toBe(404);
                expect([...response.headers], what).toEqual([...expected.headers]);
                expect(response.headers.has("allow"), what).toBe(false);
                const page =
                  method === "HEAD" ? "" : renderErrorPage({ status: 404, basePath, traceId: TRACE_ID });
                expect(await expected.text(), what).toBe(page);
                expect(await response.text(), what).toBe(page);
                expect(rawLines().slice(before), what).toEqual([NOT_FOUND_LINE, NOT_FOUND_LINE]);
                // Decided before any guard read the body.
                expect(asked.pulled(), what).toBe(0);
                expect(asked.request.bodyUsed, what).toBe(false);
                same += 1;
              }
            }
          }
        }
        // 4 routes: GET and HEAD from 4 senders, and POST, PUT, DELETE and OPTIONS from 4 senders with 4 bodies each.
        expect(same + limit).toBe(4 * (2 * 4 + 4 * 4 * 4));
        // As web/src/routes.ts lists a tool, every method is an unknown address's. With the guard's mark alone, every
        // method a route takes is: 2 GET routes' worth of GET and HEAD... counted below, route by route.
        const taken = tool.routes.reduce(
          (count, route) =>
            count +
            METHODS.filter((method) => takes(route, method)).reduce(
              (cases, method) => cases + SENDERS.length * bodiesOf(method).length,
              0,
            ),
          0,
        );
        expect(same).toBe(marked ? 4 * (2 * 4 + 4 * 4 * 4) : taken);
        expect(tool.calls()).toBe(0);
        expect(transport.sent).toEqual([]);
      },
    );
  });

  it("is absent for a config whose two values disagree, with either mark alone: the check fails closed", async () => {
    // Configs readWebConfig would never give: the staging mark set beside an ENVIRONMENT that is not "staging".
    const staging = readWebConfig(testVars("staging"));
    const plain: ShellRoute = {
      label: "example.plain",
      path: "/staging/example-plain",
      methods: ["GET", "POST"],
      handle: vi.fn<RouteHandler>((context) => context.page({ title: "Plain", main: "<h1>Plain</h1>" })),
    };
    for (const environment of ["production", "Staging", ""]) {
      const tool = makeTool();
      const raw: string[] = [];
      const shell = createWebShell({
        config: { ...staging, environment },
        transport: mockTransport("staging"),
        modules: [
          // The guard's mark alone, and the folder's mark alone (a route in a marked folder that left the guard out).
          folderOf(tool, false),
          { folder: "staging/example-plain", stagingOnly: true, routes: [plain] },
        ],
        log: (line) => raw.push(line),
        onRouteError: rethrow,
      });
      for (const address of ["/test/staging/example-tool/both", "/test/staging/example-plain"]) {
        for (const method of ["GET", "POST"] as const) {
          const asked = ask(address, method, { origin: ORIGIN }, method === "POST" ? "a small body" : "no body");
          expect(shell.serve(asked.request), `${method} ${address}`).toBeNull();
          expect((await shell.fetch(asked.request)).status, `${method} ${address}`).toBe(404);
          expect(asked.pulled()).toBe(0);
        }
      }
      expect(tool.calls()).toBe(0);
      expect(plain.handle).not.toHaveBeenCalled();
      expect(raw).toEqual([NOT_FOUND_LINE, NOT_FOUND_LINE, NOT_FOUND_LINE, NOT_FOUND_LINE]);
    }
  });
});

describe("on staging a guarded route is there, and the POST guards answer for it as for any route", () => {
  const SEND = "/test/staging/example-tool/send";

  it.each(LAYERS)(
    "$layers: a POST is refused 403 unless it comes from this site, unread, and no handler is called",
    async ({ marked }) => {
      const tool = makeTool();
      const { shell, lines } = testShell({ modules: [folderOf(tool, marked)] });
      const refused: { headers: Record<string, string>; body: Body }[] = [
        { headers: {}, body: "a small body" },
        { headers: {}, body: "a body over the cap" },
        { headers: { origin: "https://example.invalid" }, body: "a small body" },
        { headers: { origin: "https://example.invalid" }, body: "a body declared over the cap" },
        { headers: { origin: "null" }, body: "a small body" },
      ];
      for (const { headers, body } of refused) {
        const asked = ask(SEND, "POST", headers, body);
        const response = await shell.fetch(asked.request);
        expect(response.status).toBe(403);
        expect(await response.text()).toBe(
          renderErrorPage({ status: 403, basePath: "/test", traceId: TRACE_ID }),
        );
        expect(asked.pulled()).toBe(0);
      }
      expect(tool.calls()).toBe(0);
      expect(lines()).toEqual(
        refused.map(() => ({
          level: "info",
          msg: "page",
          trace_id: TRACE_ID,
          route: "example.tool.send",
          status: 403,
        })),
      );
    },
  );

  it.each(LAYERS)(
    "$layers: this site's own POST reaches the handler, and one over the cap is refused 413 before it is read in full",
    async ({ marked }) => {
      const tool = makeTool();
      const { shell, lines } = testShell({ modules: [folderOf(tool, marked)] });
      for (const { headers } of SENDERS.slice(2)) {
        const sent = ask(SEND, "POST", headers, "a small body");
        expect((await shell.fetch(sent.request)).status).toBe(200);
        expect(sent.pulled()).toBe(1);
      }
      expect(tool.calls()).toBe(2);

      const declared = ask(SEND, "POST", { origin: ORIGIN }, "a body declared over the cap");
      expect((await shell.fetch(declared.request)).status).toBe(413);
      expect(declared.pulled()).toBe(0);

      const streamed = ask(SEND, "POST", { origin: ORIGIN }, "a body over the cap");
      const response = await shell.fetch(streamed.request);
      expect(response.status).toBe(413);
      expect(await response.text()).toBe(renderErrorPage({ status: 413, basePath: "/test", traceId: TRACE_ID }));
      // 1 KiB chunks: read to the first byte past the 16 KiB cap and no further, of 1,024 chunks in all.
      expect(streamed.pulled()).toBe(POST_BODY_MAX_BYTES / 1024 + 1);
      expect(tool.calls()).toBe(2);
      expect(lines().map((line) => [line.route, line.status])).toEqual([
        ["example.tool.send", 200],
        ["example.tool.send", 200],
        ["example.tool.send", 413],
        ["example.tool.send", 413],
      ]);
    },
  );

  it("answers a GET with no Origin, and a method the route does not take with the 405 page and Allow", async () => {
    const tool = makeTool();
    const { shell } = testShell({ modules: [folderOf(tool, true)] });
    const page = await shell.fetch(ask("/test/staging/example-tool", "GET", {}, "no body").request);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Tool example.tool.page</h1>");
    const refused = await shell.fetch(ask(SEND, "PUT", { origin: ORIGIN }, "a small body").request);
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("POST");
    expect(tool.calls()).toBe(1);
  });
});

describe("a route that is not guarded keeps the POST guards wherever it runs", () => {
  it.each(["staging", "production"] as const)(
    "on %s: 403 unless the POST comes from this site, 413 over the cap, else the handler",
    async (environment) => {
      const bodies: string[] = [];
      const form: RouteModule = {
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
      const { shell, config, lines } = testShell({ environment, modules: [form] });
      const address = `${config.basePath}/example/form`;
      const send = async (headers: Record<string, string>, body: Body): Promise<number> =>
        (await shell.fetch(ask(address, "POST", headers, body).request)).status;
      expect(await send({}, "a small body")).toBe(403);
      expect(await send({ origin: "https://example.invalid" }, "a small body")).toBe(403);
      expect(await send({ origin: "https://example.invalid" }, "a body over the cap")).toBe(403);
      expect(bodies).toEqual([]);
      expect(await send({ origin: ORIGIN }, "a body over the cap")).toBe(413);
      expect(await send({ origin: ORIGIN }, "a body declared over the cap")).toBe(413);
      expect(bodies).toEqual([]);
      expect(await send({ origin: ORIGIN }, "a small body")).toBe(200);
      expect(await send({ origin: "null", "sec-fetch-site": "same-origin" }, "a small body")).toBe(200);
      expect(bodies).toEqual(["a".repeat(16), "a".repeat(16)]);
      expect([...new Set(lines().map((line) => line.route))]).toEqual(["example.form"]);
    },
  );
});

describe("an unknown address still answers 404 to any POST, whoever sent it and whatever it carries", () => {
  it.each(["staging", "production"] as const)(
    "on %s: the 404 page under the notFound label, null from serve, and none of the body read",
    async (environment) => {
      const tool = makeTool();
      const { shell, config, rawLines } = testShell({ environment, modules: [folderOf(tool, true)] });
      const { basePath } = config;
      const addresses = [
        `${basePath}/dummy-unknown-address`,
        `${basePath}/staging/example-tool/dummy-unknown-address`,
        "/dummy-outside/the-base-path/of-staging",
      ];
      let sent = 0;
      for (const address of addresses) {
        for (const { from, headers } of SENDERS) {
          for (const body of BODIES) {
            const what = `POST ${address}, ${from}, ${body}`;
            const asked = ask(address, "POST", headers, body);
            expect(shell.serve(asked.request), what).toBeNull();
            const response = await shell.fetch(asked.request);
            sent += 1;
            expect(response.status, what).toBe(404);
            expect(response.headers.has("allow"), what).toBe(false);
            expect(await response.text(), what).toBe(
              renderErrorPage({ status: 404, basePath, traceId: TRACE_ID }),
            );
            expect(asked.pulled(), what).toBe(0);
            expect(asked.request.bodyUsed, what).toBe(false);
          }
        }
      }
      expect(sent).toBe(3 * 4 * 4);
      expect(rawLines()).toEqual(Array.from({ length: sent }, () => NOT_FOUND_LINE));
      expect(tool.calls()).toBe(0);
    },
  );
});
