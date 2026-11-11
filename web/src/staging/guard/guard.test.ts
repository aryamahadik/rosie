// T-522's proofs for the staging-only guard: with ENVIRONMENT=production (and any other value that is not exactly
// "staging") every staging tool route answers the shell's 404 and the tool's handler is never called; with
// ENVIRONMENT=staging the routes answer. Each handler is a spy, and every route a made-up tool lists is asked with GET,
// POST and HEAD: as web/src/routes.ts lists a tool (the shell's own check and the guard), and with the folder's
// staging-only mark taken away (the guard alone). Beside them: the guard reads the config alone, never the request; it
// fails closed on a config readWebConfig would never give; and the tool folders web/src/routes.ts lists keep both
// checks. The shell runs on the Tool API mock (shell/test-support.ts); every request value is made up (rule 9).
import { describe, expect, it, vi, type Mock } from "vitest";
import { mockTransport } from "../../client/test-support";
import { ROUTE_MODULES } from "../../routes";
import { readWebConfig, type WebConfig } from "../../shell/config";
import { renderErrorPage } from "../../shell/error-pages";
import {
  routeTable,
  type RouteContext,
  type RouteMethod,
  type RouteModule,
  type ShellRoute,
} from "../../shell/route";
import { createWebShell, type PageLogLine, type WebShell } from "../../shell/shell";
import { TEST_LINK_HOST, TRACE_ID, rethrow, testShell, testVars } from "../../shell/test-support";
import { createWebWorker } from "../../shell/worker";
import {
  STAGING_ENVIRONMENT,
  isGuarded,
  isStagingConfig,
  stagingOnly,
  stagingOnlyRoutes,
  type RouteHandler,
} from "./index";

/** A made-up test tool: its routes as a tool's routes.ts would list them, each handler a spy. */
interface Tool {
  /** The routes as the tool wrote them, before the guard. */
  readonly listed: readonly ShellRoute[];
  /** The tool's ROUTES: the list through the guard. */
  readonly routes: readonly ShellRoute[];
  /** Each handler's spy, by its route's label. */
  readonly spies: ReadonlyMap<string, Mock<RouteHandler>>;
  /** How many times any handler of the tool was called. */
  readonly calls: () => number;
}

function makeTool(): Tool {
  const spies = new Map<string, Mock<RouteHandler>>();
  const route = (label: string, path: string, methods: readonly RouteMethod[]): ShellRoute => {
    const spy = vi.fn<RouteHandler>((context) =>
      context.page({ title: "Tool", main: `<h1>Tool ${label}</h1>`, forms: true }),
    );
    spies.set(label, spy);
    return { label, path, methods, handle: spy };
  };
  const listed = [
    route("example.tool.page", "/staging/example-tool", ["GET"]),
    route("example.tool.send", "/staging/example-tool/send", ["POST"]),
    route("example.tool.both", "/staging/example-tool/both", ["GET", "POST"]),
    route("example.tool.item", "/staging/example-tool/items/:item", ["GET", "POST"]),
  ];
  return {
    listed,
    routes: stagingOnlyRoutes(listed),
    spies,
    calls: () => [...spies.values()].reduce((count, spy) => count + spy.mock.calls.length, 0),
  };
}

/**
 * The tool's folder as the shell is handed it. Marked: as web/src/routes.ts lists a test tool, so the shell's own check
 * and the guard both stand. Not marked: the shell's check taken away, so the guard stands alone.
 */
const folderOf = (tool: Tool, marked: boolean): RouteModule => ({
  folder: "staging/example-tool",
  stagingOnly: marked,
  routes: tool.routes,
});

const LAYERS = [
  { layers: "the shell's check and the guard, as web/src/routes.ts lists a tool", marked: true },
  { layers: "the guard alone, the folder's staging-only mark taken away", marked: false },
];

/** The methods every route is asked with. */
const METHODS = ["GET", "POST", "HEAD"] as const;
type Method = (typeof METHODS)[number];

/** True when the route takes the method: HEAD rides with GET (shell/shell.ts). */
const takes = (route: ShellRoute, method: Method): boolean =>
  route.methods.some((taken) => taken === method || (taken === "GET" && method === "HEAD"));

/** The route's address under the base path, its :item named. */
const addressOf = (basePath: string, route: ShellRoute): string =>
  `${basePath}${route.path.replace(":item", "dummy-item")}`;

/** One request at `address`, under the tests' trace id, with whatever else it is given. */
function ask(address: string, method: Method, headers: Record<string, string> = {}): Request {
  return new Request(`https://${TEST_LINK_HOST}${address}`, {
    method,
    headers: { "x-trace-id": TRACE_ID, ...headers },
    ...(method === "POST" ? { body: "fire=now&ENVIRONMENT=staging&staging=true" } : {}),
  });
}

/** The shell's 404 page for the tests' trace id. */
const notFoundPage = (basePath: string): string =>
  renderErrorPage({ status: 404, basePath, traceId: TRACE_ID });

/** ENVIRONMENT values readWebConfig takes that are not exactly "staging". */
const NOT_STAGING = [
  "production",
  "Staging",
  "STAGING",
  "sTAGING",
  " staging",
  "staging ",
  "staging\n",
  "stagin",
  "staging2",
  "staging-production",
  "production,staging",
  "prod",
  "preview",
  "development",
  "test",
  "true",
  "1",
].map((value) => ({ value, shown: JSON.stringify(value) }));

/** The config of a web app on staging and of one in production, as readWebConfig gives them. */
const STAGING_CONFIG = readWebConfig(testVars("staging"));
const PRODUCTION_CONFIG = readWebConfig(testVars("production"));

/**
 * Asks every route of the tool with GET, POST and HEAD and holds each answer to "the tool does not exist here": the
 * shell's 404 page, as an unknown address gets it. With the guard alone, a method a route does not take gets the
 * shell's 405 page before any handler (guard.ts, "One limit"). Gives the number of requests it sent.
 */
async function expectNoTool(shell: WebShell, basePath: string, tool: Tool, listed: boolean): Promise<number> {
  const unknown = await shell.fetch(ask(`${basePath}/dummy-unknown-address`, "GET"));
  expect(unknown.status).toBe(404);
  let sent = 0;
  for (const route of tool.routes) {
    for (const method of METHODS) {
      const what = `${method} ${addressOf(basePath, route)}`;
      const response = await shell.fetch(ask(addressOf(basePath, route), method));
      sent += 1;
      if (listed && !takes(route, method)) {
        expect(response.status, what).toBe(405);
        continue;
      }
      expect(response.status, what).toBe(404);
      expect([...response.headers], what).toEqual([...unknown.headers]);
      expect(await response.text(), what).toBe(method === "HEAD" ? "" : notFoundPage(basePath));
    }
  }
  return sent;
}

describe("with ENVIRONMENT=production every staging tool route answers 404 and the tool's handler is never called", () => {
  describe.each(LAYERS)("$layers", ({ marked }) => {
    it.each(NOT_STAGING)(
      "ENVIRONMENT $shown: every route, for GET, POST and HEAD, answers the shell's 404 page, no handler is called and no call is made",
      async ({ value }) => {
        for (const basePath of ["", "/test"]) {
          const tool = makeTool();
          const { shell, config, lines, transport } = testShell({
            modules: [folderOf(tool, marked)],
            vars: { ...testVars("staging"), ENVIRONMENT: value, BASE_PATH: basePath },
          });
          expect(config.environment).toBe(value);
          const sent = await expectNoTool(shell, basePath, tool, !marked);
          expect(sent).toBe(tool.routes.length * METHODS.length);
          expect(tool.calls()).toBe(0);
          for (const spy of tool.spies.values()) expect(spy).not.toHaveBeenCalled();
          expect(transport.sent).toEqual([]);
          // One line each (the unknown address first), and none of them a page that was shown.
          expect(lines()).toHaveLength(sent + 1);
          expect(lines().filter((line) => line.status < 400)).toEqual([]);
          // With the shell's own check, a tool's address is like any unknown address in the log too.
          if (marked) expect([...new Set(lines().map((line) => line.route))]).toEqual(["notFound"]);
        }
      },
    );
  });

  it("is the same answer on staging's own base path in production, and under an address a tool never listed", async () => {
    const tool = makeTool();
    const { shell } = testShell({ environment: "production", modules: [folderOf(tool, false)] });
    for (const address of [
      "/test/staging/example-tool",
      "/staging/example-tool/",
      "/staging/example-tool/other",
    ]) {
      const response = await shell.fetch(ask(address, "GET"));
      expect(response.status, address).toBe(404);
      expect(await response.text(), address).toBe(notFoundPage(""));
    }
    expect(tool.calls()).toBe(0);
  });
});

describe("with ENVIRONMENT=staging the routes answer", () => {
  it.each(LAYERS)(
    "$layers: every route answers each method it takes with its handler's page, called once with the shell's context",
    async ({ marked }) => {
      const tool = makeTool();
      const { shell, config, lines } = testShell({ modules: [folderOf(tool, marked)] });
      expect(config.environment).toBe(STAGING_ENVIRONMENT);
      let sent = 0;
      for (const route of tool.routes) {
        const spy = tool.spies.get(route.label);
        if (spy === undefined) throw new Error(`${route.label} has no spy`);
        for (const method of METHODS.filter((asked) => takes(route, asked))) {
          const what = `${method} ${addressOf("/test", route)}`;
          spy.mockClear();
          const response = await shell.fetch(ask(addressOf("/test", route), method));
          sent += 1;
          expect(response.status, what).toBe(200);
          expect(response.headers.get("x-trace-id"), what).toBe(TRACE_ID);
          const html = await response.text();
          if (method === "HEAD") expect(html, what).toBe("");
          else expect(html, what).toContain(`<h1>Tool ${route.label}</h1>`);
          expect(spy, what).toHaveBeenCalledTimes(1);
          const context = spy.mock.calls[0]?.[0];
          expect(context?.config, what).toBe(config);
          expect(context?.request.method, what).toBe(method);
          expect(context?.traceId, what).toBe(TRACE_ID);
          expect(context?.params, what).toEqual(route.path.includes(":item") ? { item: "dummy-item" } : {});
        }
      }
      expect(sent).toBe(9);
      expect(lines().map((line) => line.status)).toEqual(Array.from({ length: sent }, () => 200));
    },
  );

  it("hands back whatever the handler answers: its own Response as it is, a promise awaited, a throw thrown on", async () => {
    const own = new Response("made by the tool", {
      status: 303,
      headers: { location: "/test/staging/next" },
    });
    const failure = new Error("dummy failure in a tool");
    const routes = stagingOnlyRoutes([
      { label: "example.own", path: "/staging/own", methods: ["POST"], handle: () => own },
      {
        label: "example.later",
        path: "/staging/later",
        methods: ["GET"],
        handle: async (context) => {
          await Promise.resolve();
          return context.page({ title: "Later", main: "<h1>Later</h1>" });
        },
      },
      {
        label: "example.throws",
        path: "/staging/throws",
        methods: ["GET"],
        handle: () => {
          throw failure;
        },
      },
    ]);
    const { shell } = testShell({ modules: [{ folder: "staging/example", stagingOnly: true, routes }] });
    const answered = await shell.fetch(ask("/test/staging/own", "POST"));
    expect(answered.status).toBe(303);
    expect(answered.headers.get("location")).toBe("/test/staging/next");
    expect(await answered.text()).toBe("made by the tool");
    const later = await shell.fetch(ask("/test/staging/later", "GET"));
    expect(later.status).toBe(200);
    expect(await later.text()).toContain("<h1>Later</h1>");
    await expect(shell.fetch(ask("/test/staging/throws", "GET"))).rejects.toBe(failure);
  });

  it("answers the same whatever the request says of where it runs", async () => {
    const tool = makeTool();
    const { shell } = testShell({ modules: [folderOf(tool, true)] });
    const response = await shell.fetch(
      ask("/test/staging/example-tool?ENVIRONMENT=production&staging=false", "GET", {
        "x-environment": "production",
        cookie: "ENVIRONMENT=production; staging=false",
      }),
    );
    expect(response.status).toBe(200);
    expect(tool.calls()).toBe(1);
  });
});

describe("the guard reads the config the shell hands a handler, never the request", () => {
  /** What a request could say to pass for staging: all of it ignored. */
  const CLAIMS = {
    "x-environment": "staging",
    environment: "staging",
    "x-staging": "true",
    cookie: "ENVIRONMENT=staging; environment=staging; staging=true",
    "x-forwarded-host": "staging.rosfield.com",
    origin: "https://rosfield.com",
    referer: "https://rosfield.com/test/staging/example-tool",
  };
  const QUERY = "?ENVIRONMENT=staging&environment=staging&staging=true&env=staging";

  it.each(LAYERS)(
    "$layers: in production no query, header, cookie or body that names staging reaches a handler",
    async ({ marked }) => {
      const tool = makeTool();
      const { shell, transport } = testShell({
        environment: "production",
        modules: [folderOf(tool, marked)],
      });
      for (const route of tool.routes) {
        for (const method of METHODS.filter((asked) => takes(route, asked))) {
          const response = await shell.fetch(ask(`${addressOf("", route)}${QUERY}`, method, CLAIMS));
          expect(response.status, `${method} ${route.path}`).toBe(404);
          if (method !== "HEAD") expect(await response.text()).toBe(notFoundPage(""));
        }
      }
      expect(tool.calls()).toBe(0);
      expect(transport.sent).toEqual([]);
    },
  );

  /** A context that holds a config and the shell's 404 alone: reading any other part of it throws. */
  function contextOf(config: unknown, notFound: Response): RouteContext {
    const made = { config, notFound: () => notFound };
    for (const part of ["request", "url", "path", "params", "traceId", "client", "envelope", "page"])
      Object.defineProperty(made, part, {
        get: () => {
          throw new Error(`the guard read the context's ${part}`);
        },
      });
    return made as unknown as RouteContext;
  }

  it("decides on the config alone: every other part of the context throws when read, and the guard reads none", async () => {
    const spy = vi.fn<RouteHandler>(() => new Response("the tool answered"));
    const guarded = stagingOnly(spy);
    const notFound = new Response(null, { status: 404 });
    expect(await guarded(contextOf(PRODUCTION_CONFIG, notFound))).toBe(notFound);
    expect(spy).not.toHaveBeenCalled();
    const staging = contextOf(STAGING_CONFIG, notFound);
    expect(await (await guarded(staging)).text()).toBe("the tool answered");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(staging);
  });

  it("answers the 404 for a context with no config at all", async () => {
    const spy = vi.fn<RouteHandler>(() => new Response("the tool answered"));
    const notFound = new Response(null, { status: 404 });
    for (const config of [undefined, null, "staging", true, 1, ["staging"]])
      expect(await stagingOnly(spy)(contextOf(config, notFound))).toBe(notFound);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the guard fails closed: a missing or malformed ENVIRONMENT never reaches a handler", () => {
  const { basePath, linkHost } = STAGING_CONFIG;
  /** Configs readWebConfig would never give, each with one fault: none is staging. */
  const HAND_MADE: { name: string; config: unknown }[] = [
    { name: "no ENVIRONMENT, the staging mark set", config: { staging: true, basePath, linkHost } },
    {
      name: "ENVIRONMENT undefined, the staging mark set",
      config: { environment: undefined, staging: true, basePath, linkHost },
    },
    { name: "ENVIRONMENT empty", config: { environment: "", staging: true, basePath, linkHost } },
    { name: "ENVIRONMENT null", config: { environment: null, staging: true, basePath, linkHost } },
    { name: "ENVIRONMENT a number", config: { environment: 1, staging: true, basePath, linkHost } },
    { name: "ENVIRONMENT true", config: { environment: true, staging: true, basePath, linkHost } },
    { name: "ENVIRONMENT a list", config: { environment: ["staging"], staging: true, basePath, linkHost } },
    {
      name: "ENVIRONMENT a String object",
      config: { environment: new String("staging"), staging: true, basePath, linkHost },
    },
    {
      name: "ENVIRONMENT production, the staging mark wrongly set",
      config: { environment: "production", staging: true, basePath, linkHost },
    },
    {
      name: "ENVIRONMENT in another case, the staging mark wrongly set",
      config: { environment: "Staging", staging: true, basePath, linkHost },
    },
    {
      name: "ENVIRONMENT staging, the mark false",
      config: { environment: "staging", staging: false, basePath, linkHost },
    },
    { name: "ENVIRONMENT staging, no mark", config: { environment: "staging", basePath, linkHost } },
    {
      name: "ENVIRONMENT staging, the mark a string",
      config: { environment: "staging", staging: "true", basePath, linkHost },
    },
    {
      name: "ENVIRONMENT staging, the mark a number",
      config: { environment: "staging", staging: 1, basePath, linkHost },
    },
    {
      name: "both values inherited, none its own",
      config: Object.assign(Object.create({ environment: "staging", staging: true }) as object, {
        basePath,
        linkHost,
      }),
    },
  ];

  it("isStagingConfig is true for staging's config alone", () => {
    expect(isStagingConfig(STAGING_CONFIG)).toBe(true);
    expect(isStagingConfig({ environment: "staging", staging: true })).toBe(true);
    expect(isStagingConfig(PRODUCTION_CONFIG)).toBe(false);
    for (const { value } of NOT_STAGING)
      expect(isStagingConfig(readWebConfig({ ...testVars("staging"), ENVIRONMENT: value })), value).toBe(
        false,
      );
    for (const { name, config } of HAND_MADE) expect(isStagingConfig(config), name).toBe(false);
    const notConfigs: unknown[] = [undefined, null, "staging", true, 1, [], ["staging"], {}, () => "staging"];
    for (const [at, config] of notConfigs.entries())
      expect(isStagingConfig(config), `item ${String(at)}`).toBe(false);
  });

  describe.each(LAYERS)("$layers", ({ marked }) => {
    it.each(HAND_MADE)(
      "$name: every route answers the shell's 404 page and no handler is called",
      async ({ config }) => {
        const tool = makeTool();
        const transport = mockTransport("staging");
        const raw: string[] = [];
        const shell = createWebShell({
          config: config as WebConfig,
          transport,
          modules: [folderOf(tool, marked)],
          log: (line) => raw.push(line),
          onRouteError: rethrow,
        });
        for (const route of tool.routes) {
          for (const method of METHODS.filter((asked) => takes(route, asked))) {
            const what = `${method} ${route.path}`;
            const response = await shell.fetch(ask(addressOf(basePath, route), method));
            expect(response.status, what).toBe(404);
            expect(await response.text(), what).toBe(method === "HEAD" ? "" : notFoundPage(basePath));
          }
        }
        expect(tool.calls()).toBe(0);
        expect(transport.sent).toEqual([]);
        expect(raw.map((line) => (JSON.parse(line) as PageLogLine).status)).toEqual(
          Array.from({ length: 9 }, () => 404),
        );
      },
    );
  });

  it.each([
    { name: "missing", env: { BASE_PATH: "/test", LINK_HOST: TEST_LINK_HOST } },
    { name: "undefined", env: { ...testVars("staging"), ENVIRONMENT: undefined } },
    { name: "empty", env: { ...testVars("staging"), ENVIRONMENT: "" } },
    { name: "null", env: { ...testVars("staging"), ENVIRONMENT: null } },
    { name: "a number", env: { ...testVars("staging"), ENVIRONMENT: 1 } },
    { name: "true", env: { ...testVars("staging"), ENVIRONMENT: true } },
    { name: "a list", env: { ...testVars("staging"), ENVIRONMENT: ["staging"] } },
    { name: "an object", env: { ...testVars("staging"), ENVIRONMENT: { is: "staging" } } },
  ])(
    "the Worker's ENVIRONMENT var $name: the Worker entry makes no shell, answers its plain 500 and calls no handler",
    async ({ env }) => {
      const tool = makeTool();
      const lines: string[] = [];
      const worker = createWebWorker({
        transport: () => mockTransport("staging"),
        modules: [folderOf(tool, false)],
        log: (line) => lines.push(line),
      });
      for (const route of tool.routes) {
        for (const method of METHODS) {
          const response = await worker.fetch(ask(addressOf("/test", route), method), env);
          expect(response.status, `${method} ${route.path}`).toBe(500);
          expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        }
      }
      expect(tool.calls()).toBe(0);
      expect(lines).toHaveLength(tool.routes.length * METHODS.length);
    },
  );

  it("the Worker's ENVIRONMENT var decides, end to end: production gives the 404, staging the tool", async () => {
    const tool = makeTool();
    const worker = createWebWorker({
      transport: (config) => mockTransport(config.staging ? "staging" : "production"),
      modules: [folderOf(tool, true)],
      log: () => undefined,
    });
    const production = await worker.fetch(ask("/staging/example-tool", "GET"), testVars("production"));
    expect(production.status).toBe(404);
    expect(await production.text()).toBe(notFoundPage(""));
    expect(tool.calls()).toBe(0);
    const staging = await worker.fetch(ask("/test/staging/example-tool", "GET"), testVars("staging"));
    expect(staging.status).toBe(200);
    expect(await staging.text()).toContain("<h1>Tool example.tool.page</h1>");
    expect(tool.calls()).toBe(1);
  });
});

describe("stagingOnlyRoutes: a tool's whole list behind the guard", () => {
  it("keeps each route's label, path and methods, in order, and changes nothing it was given", () => {
    const tool = makeTool();
    const before = tool.listed.map((route) => ({ ...route }));
    const frozen = Object.freeze(tool.listed.map((route) => Object.freeze({ ...route })));
    const routes = stagingOnlyRoutes(frozen);
    expect(routes.map(({ label, path, methods }) => ({ label, path, methods }))).toEqual(
      tool.listed.map(({ label, path, methods }) => ({ label, path, methods })),
    );
    expect(tool.listed).toEqual(before);
    expect(stagingOnlyRoutes([])).toEqual([]);
    // The shell takes the guarded list as it takes any folder's.
    expect(routeTable(routes).routes.map((entry) => entry.route)).toEqual(routes);
  });

  it("marks every route it gives as guarded, and no route a tool wrote without it", () => {
    const tool = makeTool();
    expect(tool.routes.map(isGuarded)).toEqual([true, true, true, true]);
    expect(tool.listed.map(isGuarded)).toEqual([false, false, false, false]);
    const handle = vi.fn<RouteHandler>(() => new Response("the tool answered"));
    const one = stagingOnly(handle);
    expect(isGuarded({ label: "example.one", path: "/one", methods: ["GET"], handle: one })).toBe(true);
    expect(isGuarded({ label: "example.one", path: "/one", methods: ["GET"], handle })).toBe(false);
    // Guarding a guarded handler again gives the same handler.
    expect(stagingOnly(one)).toBe(one);
    expect(handle).not.toHaveBeenCalled();
  });

  it("calls a route's handler as the route's own, with the context it was handed", async () => {
    const seen: unknown[] = [];
    const route = {
      label: "example.own",
      path: "/staging/own",
      methods: ["GET"],
      handle(this: unknown, context: RouteContext): Response {
        seen.push(this, context);
        return new Response("the tool answered");
      },
    } satisfies ShellRoute;
    const [guarded] = stagingOnlyRoutes([route]);
    const context = { config: STAGING_CONFIG, notFound: () => new Response(null, { status: 404 }) };
    const answer = await guarded?.handle(context as unknown as RouteContext);
    expect(await answer?.text()).toBe("the tool answered");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(route);
    expect(seen[1]).toBe(context);
  });
});

describe("the test tools' own folders (web/src/routes.ts) keep both checks", () => {
  it("every route a staging-only folder lists is behind the guard, and a guarded route sits only in such a folder", () => {
    expect(ROUTE_MODULES.filter((module) => module.stagingOnly).length).toBeGreaterThan(0);
    for (const module of ROUTE_MODULES) {
      for (const route of module.routes) {
        const fix = module.stagingOnly
          ? "export the folder's ROUTES through stagingOnlyRoutes (web/src/staging/guard/README.md)"
          : "a guarded route belongs to a folder marked stagingOnly in web/src/routes.ts";
        expect(isGuarded(route), `${module.folder}, ${route.label}: ${fix}`).toBe(module.stagingOnly);
      }
    }
  });
});
