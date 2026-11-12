// T-1237's proofs for the shell's host rule (DL-490, DL-491; T-520's security review, note b): a POST is taken only
// when it was sent to the site's own host, LINK_HOST (post-guard.ts, check 1). On any other host, the workers.dev
// address above all, a POST to a route that would otherwise take it gets the 403 page before any handler runs and
// before any of its body is read, whether it carries this site's own Origin or Origin null with Sec-Fetch-Site
// same-origin; the same POST on LINK_HOST is answered as before. GET and HEAD answer on every host as before. A guarded
// route outside staging, and an unknown address, still get the 404 first (T-520 round 2), and a method a route does not
// take still gets the 405. The request's host is only compared, never shown, logged or used to build a link or an
// origin. The routes are made up, each handler a spy, and every host and value is made up (rule 9).
import { describe, expect, it, vi, type Mock } from "vitest";
import { mockTransport } from "../client/test-support";
import { ROUTE_MODULES } from "../routes";
import { stagingOnlyRoutes, type RouteHandler } from "../staging/guard";
import { readWebConfig, type WebConfig } from "./config";
import { renderErrorPage } from "./error-pages";
import { POST_BODY_MAX_BYTES, fromThisSite, siteOrigin, toThisHost } from "./post-guard";
import type { RouteModule } from "./route";
import { createWebShell, type PageLogLine } from "./shell";
import { TEST_LINK_HOST, TRACE_ID, rethrow, testShell, testVars, type TestEnvironment } from "./test-support";

const ORIGIN = `https://${TEST_LINK_HOST}`;

/** The workers.dev address the Worker also answers on (wrangler.jsonc workers_dev), its subdomain made up. */
const WORKERS_DEV = "rosie-staging.dummy-subdomain.workers.dev";

/** Hosts that are not the site's own: the tests' LINK_HOST is rosfield.com (test-support.ts). */
const OTHER_HOSTS = [
  { what: "the workers.dev address", host: WORKERS_DEV },
  { what: "a preview address on workers.dev", host: `dummy-alias-${WORKERS_DEV}` },
  { what: "another subdomain", host: `www.${TEST_LINK_HOST}` },
  { what: "a port", host: `${TEST_LINK_HOST}:8443` },
  { what: "a trailing dot", host: `${TEST_LINK_HOST}.` },
  { what: "a host that only starts with this one", host: `${TEST_LINK_HOST}.example.invalid` },
  { what: "another site", host: "example.invalid" },
];

/** The browser's same-origin word with Origin null, as a form's POST from a no-referrer page carries it (post-guard.ts). */
const NULL_ORIGIN = { origin: "null", "sec-fetch-site": "same-origin" };

/** Who a POST says it comes from: each one the origin check (check 2) takes, so only the host rule can refuse it. */
const SENDERS: { from: string; headers: Record<string, string> }[] = [
  { from: "this site's own Origin", headers: { origin: ORIGIN } },
  { from: "Origin null with Sec-Fetch-Site same-origin", headers: NULL_ORIGIN },
  { from: "no Origin with Sec-Fetch-Site same-origin", headers: { "sec-fetch-site": "same-origin" } },
];

/** What a POST carries: a small form, or 1 MiB (64 times the cap) with or without its length declared. */
const BODIES = ["a small body", "a body over the cap", "a body declared over the cap"] as const;
type Body = (typeof BODIES)[number];

const ENVIRONMENTS: TestEnvironment[] = ["staging", "production"];

/** One request, with how many chunks of its body have been read. */
interface Asked {
  readonly request: Request;
  readonly pulled: () => number;
}

/**
 * One request sent to `host` at `address`, under the tests' trace id. A body is a stream that hands out nothing until
 * it is read (highWaterMark 0), so every chunk pulled is a chunk someone read.
 */
function ask(
  host: string,
  address: string,
  method: string,
  headers: Record<string, string>,
  body: Body | null,
): Asked {
  const url = `https://${host}${address}`;
  const sent = { "x-trace-id": TRACE_ID, ...headers };
  if (body === null) return { request: new Request(url, { method, headers: sent }), pulled: () => 0 };
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

/** A made-up feature folder with one form route (GET and POST), its handler a spy that reads what was posted. */
function formFolder(): { module: RouteModule; handler: Mock<RouteHandler> } {
  const handler = vi.fn<RouteHandler>(async (context) => {
    if (context.request.method === "POST") await context.request.text();
    return context.page({ title: "Form", main: "<h1>Form</h1>", forms: true });
  });
  const module: RouteModule = {
    folder: "example",
    stagingOnly: false,
    routes: [{ label: "example.form", path: "/example/form", methods: ["GET", "POST"], handle: handler }],
  };
  return { module, handler };
}

/** A made-up staging tool with one form route behind the staging-only guard, with its folder's mark or without it. */
function toolFolder(marked: boolean): { module: RouteModule; handler: Mock<RouteHandler> } {
  const handler = vi.fn<RouteHandler>(async (context) => {
    await context.request.text();
    return context.page({ title: "Tool", main: "<h1>Tool</h1>", forms: true });
  });
  const module: RouteModule = {
    folder: "staging/example-tool",
    stagingOnly: marked,
    routes: stagingOnlyRoutes([
      { label: "example.tool.send", path: "/staging/example-tool/send", methods: ["POST"], handle: handler },
    ]),
  };
  return { module, handler };
}

/** The one log line of a request no route answers. */
const NOT_FOUND_LINE = JSON.stringify({
  level: "info",
  msg: "page",
  trace_id: TRACE_ID,
  route: "notFound",
  status: 404,
} satisfies PageLogLine);

describe("a POST sent to any host but LINK_HOST is refused 403 before any handler runs and before its body is read", () => {
  describe.each(ENVIRONMENTS)("on %s", (environment) => {
    it.each(OTHER_HOSTS)(
      "$what ($host): from each sender the origin check takes, with any body, the 403 page and one line, and nothing of the host kept",
      async ({ host }) => {
        const { module, handler } = formFolder();
        const { shell, config, lines, rawLines, transport } = testShell({ environment, modules: [module] });
        const address = `${config.basePath}/example/form`;
        let refused = 0;
        for (const { from, headers } of SENDERS) {
          for (const body of BODIES) {
            const what = `${from}, ${body}`;
            const asked = ask(host, address, "POST", headers, body);
            // The origin check alone would take it, so the 403 is the host rule's.
            expect(fromThisSite(asked.request, config), what).toBe(true);
            expect(toThisHost(asked.request, config), what).toBe(false);
            const response = await shell.fetch(asked.request);
            expect(response.status, what).toBe(403);
            expect(response.headers.get("x-trace-id"), what).toBe(TRACE_ID);
            expect(response.headers.has("set-cookie"), what).toBe(false);
            expect(await response.text(), what).toBe(
              renderErrorPage({ status: 403, basePath: config.basePath, traceId: TRACE_ID }),
            );
            // Refused before any of the body was read, even one declared over the cap: never the 413.
            expect(asked.pulled(), what).toBe(0);
            expect(asked.request.bodyUsed, what).toBe(false);
            refused += 1;
          }
        }
        expect(refused).toBe(SENDERS.length * BODIES.length);
        expect(handler).not.toHaveBeenCalled();
        expect(transport.sent).toEqual([]);
        expect(lines()).toEqual(
          Array.from({ length: refused }, () => ({
            level: "info",
            msg: "page",
            trace_id: TRACE_ID,
            route: "example.form",
            status: 403,
          })),
        );
        expect(rawLines().join("\n")).not.toContain(host);
      },
    );

    it("serve answers it as fetch does: the route is there, and the POST gets the 403 page", async () => {
      const { module, handler } = formFolder();
      const { shell, config } = testShell({ environment, modules: [module] });
      for (const { from, headers } of SENDERS) {
        const asked = ask(WORKERS_DEV, `${config.basePath}/example/form`, "POST", headers, "a small body");
        expect((await shell.serve(asked.request))?.status, from).toBe(403);
        expect(asked.pulled(), from).toBe(0);
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it("the same POST sent to LINK_HOST is answered as before: the handler under the cap, the 413 page over it", async () => {
      const { module, handler } = formFolder();
      const { shell, config, lines } = testShell({ environment, modules: [module] });
      const address = `${config.basePath}/example/form`;
      for (const { from, headers } of SENDERS) {
        const small = ask(TEST_LINK_HOST, address, "POST", headers, "a small body");
        expect(toThisHost(small.request, config), from).toBe(true);
        expect((await shell.fetch(small.request)).status, from).toBe(200);
        expect(small.pulled(), from).toBe(1);
        const declared = ask(TEST_LINK_HOST, address, "POST", headers, "a body declared over the cap");
        expect((await shell.fetch(declared.request)).status, from).toBe(413);
        expect(declared.pulled(), from).toBe(0);
        const over = ask(TEST_LINK_HOST, address, "POST", headers, "a body over the cap");
        expect((await shell.fetch(over.request)).status, from).toBe(413);
        // 1 KiB chunks: read to the first byte past the 16 KiB cap and no further.
        expect(over.pulled(), from).toBe(POST_BODY_MAX_BYTES / 1024 + 1);
      }
      expect(handler).toHaveBeenCalledTimes(SENDERS.length);
      expect(lines().map((line) => line.status)).toEqual(SENDERS.flatMap(() => [200, 413, 413]));
    });
  });

  it("a host that differs from LINK_HOST only in case is refused, from both Origin paths: the comparison folds no case", async () => {
    // A URL's host is always lower case once parsed (next test), so only a LINK_HOST with capitals can differ from it in
    // case alone. readWebConfig refuses one, so the shell is handed such a config directly.
    for (const environment of ENVIRONMENTS) {
      const config: WebConfig = { ...readWebConfig(testVars(environment)), linkHost: "RosField.com" };
      const { module, handler } = formFolder();
      const raw: string[] = [];
      const shell = createWebShell({
        config,
        transport: mockTransport(environment),
        modules: [module],
        log: (line) => raw.push(line),
        onRouteError: rethrow,
      });
      const senders = [
        { from: "this site's own Origin, as the config names it", headers: { origin: siteOrigin(config) } },
        { from: "Origin null with Sec-Fetch-Site same-origin", headers: NULL_ORIGIN },
      ];
      for (const { from, headers } of senders) {
        const what = `${environment}: ${from}`;
        const asked = ask(TEST_LINK_HOST, `${config.basePath}/example/form`, "POST", headers, "a small body");
        expect(fromThisSite(asked.request, config), what).toBe(true);
        expect(toThisHost(asked.request, config), what).toBe(false);
        expect((await shell.fetch(asked.request)).status, what).toBe(403);
        expect(asked.pulled(), what).toBe(0);
      }
      expect(handler).not.toHaveBeenCalled();
      expect(raw.map((line) => (JSON.parse(line) as PageLogLine).status)).toEqual([403, 403]);
    }
  });
});

describe("toThisHost: the host of the request's URL, compared with LINK_HOST exactly", () => {
  const at = (url: string, linkHost: string = TEST_LINK_HOST): boolean =>
    toThisHost(new Request(url), readWebConfig({ ...testVars("production"), LINK_HOST: linkHost }));

  it("is true on LINK_HOST alone, whatever the path or query, and false on every other host", () => {
    expect(at(`https://${TEST_LINK_HOST}/`)).toBe(true);
    expect(at(`https://${TEST_LINK_HOST}/test/sign-in?link=dummy-code`)).toBe(true);
    for (const { host } of OTHER_HOSTS) expect(at(`https://${host}/test/sign-in`), host).toBe(false);
  });

  it("matches a LINK_HOST with a port on that port alone", () => {
    expect(at("http://localhost:8787/test/sign-in", "localhost:8787")).toBe(true);
    expect(at("http://localhost:8788/test/sign-in", "localhost:8787")).toBe(false);
    expect(at("http://localhost/test/sign-in", "localhost:8787")).toBe(false);
    expect(at("http://localhost:8787/test/sign-in")).toBe(false);
  });

  it("takes the host as the URL standard parses it: capitals are lowered and the scheme's own port is dropped", () => {
    // Both are the same host as LINK_HOST to a browser, and the Worker's request holds its URL parsed the same way.
    expect(new Request("https://RosField.COM/test/sign-in").url).toBe(
      `https://${TEST_LINK_HOST}/test/sign-in`,
    );
    expect(at("https://RosField.COM/test/sign-in")).toBe(true);
    expect(at(`https://${TEST_LINK_HOST}:443/test/sign-in`)).toBe(true);
  });
});

describe("GET and HEAD answer on every host as before", () => {
  it.each(ENVIRONMENTS)(
    "on %s: a form page, a static page and an unknown address give on each other host what they give on LINK_HOST, byte for byte",
    async (environment) => {
      const { module, handler } = formFolder();
      const { shell, config } = testShell({ environment, modules: [module] });
      const addresses = [
        { address: `${config.basePath}/example/form`, status: 200 },
        { address: `${config.basePath}/privacy`, status: 200 },
        { address: `${config.basePath}/dummy-unknown-address`, status: 404 },
      ];
      for (const { address, status } of addresses) {
        for (const method of ["GET", "HEAD"]) {
          const own = await shell.fetch(ask(TEST_LINK_HOST, address, method, {}, null).request);
          expect(own.status, `${method} ${address}`).toBe(status);
          const ownBody = await own.text();
          for (const { host } of OTHER_HOSTS) {
            const what = `${method} https://${host}${address}`;
            const response = await shell.fetch(ask(host, address, method, {}, null).request);
            expect(response.status, what).toBe(status);
            expect([...response.headers], what).toEqual([...own.headers]);
            expect(await response.text(), what).toBe(ownBody);
          }
        }
      }
      // The form page's handler answered its GET and its HEAD on every host.
      expect(handler).toHaveBeenCalledTimes(2 * (1 + OTHER_HOSTS.length));
    },
  );
});

describe("on any other host, what came before the POST guards still answers first", () => {
  it.each(OTHER_HOSTS)(
    "$what: outside staging a guarded route, and anywhere an unknown address, give the 404, never the 403",
    async ({ host }) => {
      for (const marked of [true, false]) {
        for (const environment of ENVIRONMENTS) {
          const tool = toolFolder(marked);
          const { shell, config, rawLines } = testShell({ environment, modules: [tool.module] });
          const addresses = [`${config.basePath}/dummy-unknown-address`];
          // Outside staging the tool's address is an unknown address too (T-520 round 2).
          if (environment === "production") addresses.push(`${config.basePath}/staging/example-tool/send`);
          let sent = 0;
          for (const address of addresses) {
            for (const { from, headers } of SENDERS) {
              for (const body of BODIES) {
                const what = `${environment}, marked ${String(marked)}: POST ${address}, ${from}, ${body}`;
                const asked = ask(host, address, "POST", headers, body);
                expect(shell.serve(asked.request), what).toBeNull();
                const response = await shell.fetch(asked.request);
                expect(response.status, what).toBe(404);
                expect(response.headers.has("allow"), what).toBe(false);
                expect(await response.text(), what).toBe(
                  renderErrorPage({ status: 404, basePath: config.basePath, traceId: TRACE_ID }),
                );
                expect(asked.pulled(), what).toBe(0);
                expect(asked.request.bodyUsed, what).toBe(false);
                sent += 1;
              }
            }
          }
          expect(rawLines()).toEqual(Array.from({ length: sent }, () => NOT_FOUND_LINE));
          expect(tool.handler).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(OTHER_HOSTS)(
    "$what: on staging, where the tool's route is in the table, its POST gets the host rule's 403 and the tool never runs",
    async ({ host }) => {
      const tool = toolFolder(true);
      const { shell, config } = testShell({ modules: [tool.module] });
      for (const { from, headers } of SENDERS) {
        const asked = ask(
          host,
          `${config.basePath}/staging/example-tool/send`,
          "POST",
          headers,
          "a small body",
        );
        expect((await shell.fetch(asked.request)).status, from).toBe(403);
        expect(asked.pulled(), from).toBe(0);
      }
      expect(tool.handler).not.toHaveBeenCalled();
    },
  );

  it.each(OTHER_HOSTS)(
    "$what: a POST to a page that takes GET alone gets the 405 page with Allow, as before",
    async ({ host }) => {
      for (const environment of ENVIRONMENTS) {
        const { shell, config } = testShell({ environment });
        const asked = ask(host, `${config.basePath}/privacy`, "POST", { origin: ORIGIN }, "a small body");
        const response = await shell.fetch(asked.request);
        expect(response.status, environment).toBe(405);
        expect(response.headers.get("allow"), environment).toBe("GET, HEAD");
        expect(asked.pulled(), environment).toBe(0);
      }
    },
  );
});

describe("every form route web/src/routes.ts lists is refused on the workers.dev address", () => {
  it("on staging, where every folder is served: each route that takes a POST answers it 403, and no K-21 call is sent", async () => {
    const { shell, config, transport, lines } = testShell();
    const posting = ROUTE_MODULES.flatMap((module) => module.routes).filter((route) =>
      route.methods.includes("POST"),
    );
    // The sign-in forms (web/src/auth; T-520) are among them.
    const labels = posting.map((route) => route.label);
    for (const label of ["auth.signIn", "auth.signInCheck", "auth.signOut"]) expect(labels).toContain(label);
    for (const route of posting) {
      const address = `${config.basePath}${route.path.replace(/:[A-Za-z0-9]+/g, "dummy-segment")}`;
      for (const { from, headers } of SENDERS) {
        const form = { "content-type": "application/x-www-form-urlencoded", ...headers };
        const asked = ask(WORKERS_DEV, address, "POST", form, "a small body");
        expect((await shell.fetch(asked.request)).status, `${route.label}, ${from}`).toBe(403);
        expect(asked.pulled(), `${route.label}, ${from}`).toBe(0);
      }
    }
    expect(transport.sent).toEqual([]);
    expect(lines().map((line) => [line.route, line.status])).toEqual(
      posting.flatMap((route) => SENDERS.map(() => [route.label, 403])),
    );
  });
});

describe("a local wrangler dev session posts a form by naming its own host as LINK_HOST (web/README.md)", () => {
  it("LINK_HOST localhost:8787 takes a form's POST to http://localhost:8787; the deployed LINK_HOST refuses that same POST", async () => {
    /** A form's POST as a browser sends it from a page served under no-referrer, to the local address. */
    const posted = (): Request =>
      new Request("http://localhost:8787/test/example/form", {
        method: "POST",
        headers: {
          ...NULL_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
          "x-trace-id": TRACE_ID,
        },
        body: "field=dummy-value",
      });

    const local = formFolder();
    const session = testShell({
      modules: [local.module],
      vars: { ...testVars("staging"), LINK_HOST: "localhost:8787" },
    });
    expect((await session.shell.fetch(posted())).status).toBe(200);
    expect(local.handler).toHaveBeenCalledTimes(1);

    const deployed = formFolder();
    const asDeployed = testShell({ modules: [deployed.module] });
    expect(asDeployed.config.linkHost).toBe(TEST_LINK_HOST);
    expect((await asDeployed.shell.fetch(posted())).status).toBe(403);
    expect(deployed.handler).not.toHaveBeenCalled();
  });
});
